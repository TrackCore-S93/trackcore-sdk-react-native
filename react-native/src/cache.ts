/**
 * ETag / `If-None-Match` revalidation, optionally persisted to `AsyncStorage`.
 *
 * **Revalidation only. There is no offline support in this SDK and there will
 * not be one here.** That was settled on 2026-10-23: portion edits require the
 * network and clients never do their own scaling (SDK-C2, DM-N10). `grounds`,
 * this customer's Flutter app, lost 12 of 19 nutrients by scaling a subset of
 * fields on the client; a cache that answers without asking the server is one
 * step from the same class of mistake, because the thing it is deciding is what
 * a food's nutrition is.
 *
 * So: every read still goes to the server. What is stored is a validator and
 * the body it validates, and a `304` is the only thing that lets the stored
 * body be reused. No TTL, no staleness heuristic, no serve-while-revalidate, no
 * queue. `@trackcore/sdk`'s `Transport` implements all of that already; this
 * file only gives it somewhere to put things that survives an app restart.
 *
 * # Why this is not just `MemoryResponseCache` with AsyncStorage bolted on
 *
 * Two problems, and the first is the dangerous one.
 *
 * ## 1. `JSON.stringify` on a cached body destroys the thing the SDK exists for
 *
 * The entries `Transport` hands over hold the **parsed** body, which means
 * every nutrient is a `Decimal` carrying its exact lexeme. `Decimal.toJSON()`
 * emits the lexeme verbatim through `JSON.rawJSON` — and `JSON.rawJSON` is
 * ES2025, which **Hermes does not have**. On Hermes the documented fallback is
 * a bare double, so the obvious one-liner
 *
 *     AsyncStorage.setItem(key, JSON.stringify(entry))
 *
 * writes `138` where the server sent `138.000`, and a later `304` serves it
 * back as fact. That is the product's core promise, broken quietly, on the
 * platform the SDK is for. `Decimal.isExactlyReSerialisable()` reports exactly
 * this and returns `false` under Hermes.
 *
 * The codec below therefore replaces every `Decimal` with a **string** sentinel
 * holding `decimal.source` before serialising, and rebuilds it with
 * `new Decimal(source)` on the way back. No numeric lexeme is ever handed to
 * `JSON.stringify`, so there is nothing for it to flatten. The round trip uses
 * `Decimal`'s own public surface and duplicates none of its parsing.
 *
 * After encoding, **the stored document contains no JSON number at all** —
 * every value is a string, a boolean, `null`, an array or an object. That is
 * what makes the `JSON.parse` on the read path safe, and
 * `test/cache.test.ts` asserts the no-numbers property directly rather than
 * trusting this paragraph.
 *
 * ## 2. `ResponseCache` is synchronous and `AsyncStorage` is not
 *
 * `Transport` calls `cache.get(key)` in the middle of building a request and
 * expects an answer, not a promise. Changing that interface would fork the
 * transport, which is the one thing this package must not do.
 *
 * So memory is the synchronous face and storage is a write-behind log:
 *
 *   - {@link AsyncStorageResponseCache.hydrate} loads the persisted entries
 *     into memory once, at startup, and the app awaits it. Until it resolves
 *     the cache is simply empty, which costs a full response and nothing else.
 *   - `set`/`delete`/`clear` update memory immediately and append to a
 *     serialised write queue.
 *   - A storage failure never reaches the request path. It goes to `onError`,
 *     and the request continues uncached — a device with a full disk should
 *     still be able to look up a food.
 *
 * The in-memory half is `@trackcore/sdk`'s own `MemoryResponseCache`, held by
 * composition. The LRU bound is not reimplemented here.
 */

import { Decimal, MemoryResponseCache, type CacheEntry, type JsonValue, type ResponseCache } from "@trackcore/sdk";

/**
 * The slice of `@react-native-async-storage/async-storage` this package uses.
 *
 * Declared structurally and **never imported**, so installing this SDK pulls in
 * no native code (SDK-R2). A customer who wants persistence passes the module
 * in; a customer who does not never links it, and nothing about their build
 * changes.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys?(): Promise<readonly string[]>;
  multiRemove?(keys: readonly string[]): Promise<void>;
}

export interface AsyncStorageResponseCacheOptions {
  readonly storage: AsyncStorageLike;
  /** LRU bound on the in-memory half. Default 256, as in `@trackcore/sdk`. */
  readonly maxEntries?: number | undefined;
  /** Key namespace in storage. Default `trackcore:etag:`. */
  readonly keyPrefix?: string | undefined;
  /**
   * Where a storage failure goes. Defaults to a `console.warn`. A failure here
   * is never fatal and never reaches the caller of a TrackCore method.
   */
  readonly onError?: ((error: unknown, operation: string) => void) | undefined;
}

/**
 * Bumped whenever {@link encodeEntry} changes shape.
 *
 * A stored document whose version does not match is discarded on hydrate
 * rather than interpreted. Misreading an old record would mean serving a body
 * the SDK has misunderstood, and the whole value of an ETag is that the client
 * is certain what it is holding.
 */
const FORMAT_VERSION = 1;

/** Marks an encoded `Decimal`. A string, so `JSON.stringify` cannot touch it. */
const DECIMAL_TAG = "\u0000tc:dec:";

interface StoredEntry {
  readonly v: number;
  readonly etag: string;
  /** Milliseconds since the epoch, **as a string**: see the codec note above. */
  readonly storedAt: string;
  readonly body: unknown;
}

/** Replaces every `Decimal` with a tagged string. Leaves everything else alone. */
export function encodeBody(value: JsonValue): unknown {
  if (value instanceof Decimal) return DECIMAL_TAG + value.source;
  if (Array.isArray(value)) return value.map(encodeBody);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = encodeBody(child as JsonValue);
    return out;
  }
  // `string | boolean | null`. A bare `number` cannot occur: the parser hands
  // every number back as a Decimal, and the branch above caught those.
  return value;
}

/** The inverse. A tagged string becomes a `Decimal` with its lexeme intact. */
export function decodeBody(value: unknown): JsonValue {
  if (typeof value === "string") {
    return value.startsWith(DECIMAL_TAG) ? new Decimal(value.slice(DECIMAL_TAG.length)) : value;
  }
  if (Array.isArray(value)) return value.map(decodeBody);
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) out[key] = decodeBody(child);
    return out;
  }
  if (typeof value === "number") {
    // Unreachable for anything this cache wrote, because `encodeBody` leaves no
    // numbers behind. Reaching it means the stored document was written by
    // something else, and a double here is exactly the loss the encoding exists
    // to prevent — so it is a hard failure, not a coercion.
    throw new TypeError("trackcore cache: a stored body contained a bare JSON number");
  }
  return value as JsonValue;
}

function encodeEntry(entry: CacheEntry): string {
  const stored: StoredEntry = {
    v: FORMAT_VERSION,
    etag: entry.etag,
    storedAt: String(entry.storedAt),
    body: encodeBody(entry.body),
  };
  return JSON.stringify(stored);
}

function decodeEntry(text: string): CacheEntry | null {
  // `JSON.parse` here reads **this module's own storage format**, not a
  // TrackCore response. `encodeBody` guarantees the document holds no JSON
  // number — `storedAt` is a string and every Decimal is a tagged string — so
  // there is no lexeme for the native parser to flatten. `decodeBody` throws if
  // that invariant is ever violated. See the header note.
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stored = raw as Partial<StoredEntry>;
  if (stored.v !== FORMAT_VERSION) return null;
  if (typeof stored.etag !== "string" || typeof stored.storedAt !== "string") return null;
  const storedAt = Number(stored.storedAt);
  if (!Number.isFinite(storedAt)) return null;
  try {
    return { etag: stored.etag, body: decodeBody(stored.body), storedAt };
  } catch {
    return null;
  }
}

/**
 * An ETag store backed by memory, persisted to `AsyncStorage` behind the
 * request path.
 *
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 *
 * const cache = new AsyncStorageResponseCache({ storage: AsyncStorage });
 * await cache.hydrate();            // once, at startup
 * const client = createTrackCoreClient({ apiKey, cache });
 * ```
 */
export class AsyncStorageResponseCache implements ResponseCache {
  private readonly memory: MemoryResponseCache;
  private readonly storage: AsyncStorageLike;
  private readonly keyPrefix: string;
  private readonly onError: (error: unknown, operation: string) => void;
  /** Writes are serialised through this tail so two `set`s cannot interleave. */
  private tail: Promise<void> = Promise.resolve();
  private hydrated = false;

  constructor(options: AsyncStorageResponseCacheOptions) {
    this.memory = new MemoryResponseCache(options.maxEntries ?? 256);
    this.storage = options.storage;
    this.keyPrefix = options.keyPrefix ?? "trackcore:etag:";
    this.onError =
      options.onError ??
      ((error, operation) => {
        // eslint-disable-next-line no-console
        console.warn(`[trackcore] cache ${operation} failed; continuing without it`, error);
      });
  }

  /**
   * Loads persisted entries into memory. Call once, await it, then build the
   * client. Safe to call again; the second call is a no-op.
   *
   * Requires `getAllKeys`. Without it the cache still works for the lifetime of
   * the process and simply starts cold — reported through `onError` once, not
   * thrown, because a missing optional method is a degraded cache and not a
   * reason an app cannot search for food.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const getAllKeys = this.storage.getAllKeys?.bind(this.storage);
    if (getAllKeys === undefined) {
      this.onError(
        new Error("the supplied storage has no getAllKeys(); the ETag cache will start empty"),
        "hydrate",
      );
      return;
    }
    try {
      const keys = (await getAllKeys()).filter((key) => key.startsWith(this.keyPrefix));
      for (const storageKey of keys) {
        const text = await this.storage.getItem(storageKey);
        if (text === null) continue;
        const entry = decodeEntry(text);
        if (entry === null) {
          // Unreadable or written by an older format version. Drop it rather
          // than guess; the cost is one full response.
          void this.enqueue("hydrate-evict", () => this.storage.removeItem(storageKey));
          continue;
        }
        this.memory.set(storageKey.slice(this.keyPrefix.length), entry);
      }
    } catch (error) {
      this.onError(error, "hydrate");
    }
  }

  get(key: string): CacheEntry | undefined {
    return this.memory.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.memory.set(key, entry);
    void this.enqueue("set", async () => {
      await this.storage.setItem(this.keyPrefix + key, encodeEntry(entry));
    });
  }

  delete(key: string): void {
    this.memory.delete(key);
    void this.enqueue("delete", () => this.storage.removeItem(this.keyPrefix + key));
  }

  clear(): void {
    this.memory.clear();
    void this.enqueue("clear", async () => {
      const getAllKeys = this.storage.getAllKeys?.bind(this.storage);
      if (getAllKeys === undefined) return;
      const keys = (await getAllKeys()).filter((key) => key.startsWith(this.keyPrefix));
      const multiRemove = this.storage.multiRemove?.bind(this.storage);
      if (multiRemove !== undefined) {
        await multiRemove(keys);
        return;
      }
      for (const key of keys) await this.storage.removeItem(key);
    });
  }

  get size(): number {
    return this.memory.size;
  }

  /** Awaits every queued write. For tests and for a deliberate flush on background. */
  async flush(): Promise<void> {
    await this.tail;
  }

  private enqueue(operation: string, work: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(work).catch((error: unknown) => {
      this.onError(error, operation);
    });
    return this.tail;
  }
}

export { MemoryResponseCache };
export type { CacheEntry, ResponseCache };
