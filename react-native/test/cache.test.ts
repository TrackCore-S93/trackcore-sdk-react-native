/**
 * The ETag store, and the trap at the bottom of it.
 *
 * The dangerous part is not the LRU or the write queue — it is that the obvious
 * `JSON.stringify(entry)` destroys every nutrient's scale on Hermes, where
 * `JSON.rawJSON` does not exist. The first describe block is the one that
 * matters.
 */

import {
  AsyncStorageResponseCache,
  Decimal,
  decodeBody,
  encodeBody,
  parseJson,
  type AsyncStorageLike,
  type CacheEntry,
  type JsonValue,
} from "../src";

/** The lexemes QA verified end to end against the running service. */
const LEXEMES = [
  "138.000",
  "138.0000000000000000",
  "0.039",
  "19.06",
  "0.1",
  "62.5",
  "3.3333333333333333",
  "9007199254740993",
  "0",
  "0.010",
  "28.350",
  "-0.0",
  "1e3",
  "1.5E-7",
];

class FakeAsyncStorage implements AsyncStorageLike {
  readonly items = new Map<string, string>();
  failNext = false;

  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.items.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.items.delete(key);
  }

  async getAllKeys(): Promise<readonly string[]> {
    return [...this.items.keys()];
  }

  async multiRemove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.items.delete(key);
  }
}

describe("the storage codec never loses a lexeme", () => {
  it("round-trips every verified lexeme exactly, through a real JSON.stringify", () => {
    for (const lexeme of LEXEMES) {
      const encoded = JSON.stringify(encodeBody(new Decimal(lexeme)));
      const decoded = decodeBody(JSON.parse(encoded) as unknown);
      expect(decoded).toBeInstanceOf(Decimal);
      expect((decoded as Decimal).source).toBe(lexeme);
    }
  });

  it("demonstrates the trap it avoids: a naive stringify flattens the same values", () => {
    // Not a test of our code — a test that the problem is real on this runtime
    // when `JSON.rawJSON` is missing, which is Hermes' situation. If this ever
    // starts passing as `"138.000"`, the runtime grew rawJSON and the codec is
    // belt-and-braces rather than load-bearing; it stays either way.
    const naive = JSON.stringify({ metric_amount: new Decimal("138.000") });
    if (!Decimal.isExactlyReSerialisable()) {
      expect(naive).toBe('{"metric_amount":138}');
      expect(naive).not.toContain("138.000");
    } else {
      expect(naive).toBe('{"metric_amount":138.000}');
    }
  });

  it("leaves no bare JSON number in the stored document", () => {
    // This is what makes the JSON.parse on the read path safe. Every Decimal is
    // a tagged string and `storedAt` is a string, so there is no lexeme for the
    // native parser to flatten.
    const body = parseJson(
      '{"metric_amount":138.000,"page":0,"nutrition":{"energy":{"value":72,"unit":"kcal"},' +
        '"vitamin_d":null},"servings":[{"base_quantity":1.000}]}',
    );
    const encoded = JSON.stringify(encodeBody(body));

    // Re-read the encoded text with the lexeme-preserving parser, which hands
    // back a Decimal for every JSON *number* token. If it finds one, a value
    // escaped the Decimal tagging and `JSON.parse` on the read path would
    // flatten it. Grepping the text would not do: the tagged strings
    // themselves contain digits.
    const numbers: string[] = [];
    const walk = (value: JsonValue): void => {
      if (value instanceof Decimal) numbers.push(value.source);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(parseJson(encoded));
    expect(numbers).toEqual([]);
  });

  it("rebuilds a whole parsed response with every lexeme intact", () => {
    const text =
      '{"metric_amount":138.000,"gram_weight_per_household_unit":138.0000000000000000,' +
      '"nutrition":{"saturated_fat":{"value":0.039,"unit":"g"},' +
      '"carbohydrate":{"value":19.06,"unit":"g","basis":"total"},"vitamin_d":null},' +
      '"big":9007199254740993,"name":"Apples"}';
    const body = parseJson(text);
    const restored = decodeBody(JSON.parse(JSON.stringify(encodeBody(body))) as unknown);

    const dig = (value: JsonValue, path: string[]): JsonValue =>
      path.reduce<JsonValue>((node, key) => (node as Record<string, JsonValue>)[key] as JsonValue, value);

    expect((dig(restored, ["metric_amount"]) as Decimal).source).toBe("138.000");
    expect((dig(restored, ["gram_weight_per_household_unit"]) as Decimal).source).toBe(
      "138.0000000000000000",
    );
    expect((dig(restored, ["nutrition", "saturated_fat", "value"]) as Decimal).source).toBe("0.039");
    expect((dig(restored, ["nutrition", "carbohydrate", "value"]) as Decimal).source).toBe("19.06");
    expect((dig(restored, ["big"]) as Decimal).source).toBe("9007199254740993");
    // DM-N2's third state survives: a modelled nutrient with no value is null,
    // and never becomes 0.
    expect(dig(restored, ["nutrition", "vitamin_d"])).toBeNull();
    expect(dig(restored, ["name"])).toBe("Apples");
  });

  it("refuses a stored body that contains a bare number rather than coercing it", () => {
    expect(() => decodeBody({ value: 138 })).toThrow(/bare JSON number/);
  });

  it("does not mistake an ordinary string for an encoded Decimal", () => {
    expect(decodeBody("138.000")).toBe("138.000");
    expect(decodeBody(encodeBody("138.000"))).toBe("138.000");
  });
});

describe("AsyncStorageResponseCache", () => {
  const entry = (etag: string, lexeme: string): CacheEntry => ({
    etag,
    body: parseJson(`{"metric_amount":${lexeme}}`),
    storedAt: 1_700_000_000_000,
  });

  it("answers synchronously from memory while persisting behind the request path", async () => {
    const storage = new FakeAsyncStorage();
    const cache = new AsyncStorageResponseCache({ storage });

    cache.set("GET /v1/foods/x", entry('W/"abc"', "138.000"));
    // Synchronous: this is what Transport calls mid-request.
    expect(cache.get("GET /v1/foods/x")?.etag).toBe('W/"abc"');
    expect(storage.items.size).toBe(0);

    await cache.flush();
    expect(storage.items.size).toBe(1);
    expect([...storage.items.keys()][0]).toBe("trackcore:etag:GET /v1/foods/x");
  });

  it("survives a restart with the lexeme intact", async () => {
    const storage = new FakeAsyncStorage();
    const first = new AsyncStorageResponseCache({ storage });
    first.set("GET /v1/foods/x", entry('W/"abc"', "138.0000000000000000"));
    await first.flush();

    const second = new AsyncStorageResponseCache({ storage });
    expect(second.get("GET /v1/foods/x")).toBeUndefined(); // cold until hydrated
    await second.hydrate();

    const restored = second.get("GET /v1/foods/x");
    expect(restored?.etag).toBe('W/"abc"');
    const amount = (restored?.body as Record<string, Decimal>)["metric_amount"] as Decimal;
    expect(amount.source).toBe("138.0000000000000000");
    expect(restored?.storedAt).toBe(1_700_000_000_000);
  });

  it("never throws a storage failure into the request path", async () => {
    const storage = new FakeAsyncStorage();
    const errors: Array<[unknown, string]> = [];
    const cache = new AsyncStorageResponseCache({
      storage,
      onError: (error, operation) => errors.push([error, operation]),
    });

    storage.failNext = true;
    expect(() => cache.set("GET /a", entry('W/"1"', "1.0"))).not.toThrow();
    // Memory still has it: a full disk should not stop the app working.
    expect(cache.get("GET /a")?.etag).toBe('W/"1"');
    await cache.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toBe("set");
  });

  it("discards a record written by an older format version instead of guessing", async () => {
    const storage = new FakeAsyncStorage();
    storage.items.set("trackcore:etag:GET /a", JSON.stringify({ v: 0, etag: "x", body: {} }));
    const cache = new AsyncStorageResponseCache({ storage });
    await cache.hydrate();
    expect(cache.get("GET /a")).toBeUndefined();
    await cache.flush();
    expect(storage.items.size).toBe(0);
  });

  it("discards an unparseable record", async () => {
    const storage = new FakeAsyncStorage();
    storage.items.set("trackcore:etag:GET /a", "{not json");
    const cache = new AsyncStorageResponseCache({ storage });
    await cache.hydrate();
    expect(cache.get("GET /a")).toBeUndefined();
  });

  it("ignores keys outside its namespace", async () => {
    const storage = new FakeAsyncStorage();
    storage.items.set("some-other-library:thing", "{}");
    const cache = new AsyncStorageResponseCache({ storage });
    await cache.hydrate();
    expect(cache.size).toBe(0);
    expect(storage.items.has("some-other-library:thing")).toBe(true);
  });

  it("starts cold, reporting once, when storage has no getAllKeys", async () => {
    const minimal: AsyncStorageLike = {
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    };
    const errors: string[] = [];
    const cache = new AsyncStorageResponseCache({
      storage: minimal,
      onError: (_error, operation) => errors.push(operation),
    });
    await cache.hydrate();
    await cache.hydrate();
    expect(errors).toEqual(["hydrate"]);
  });

  it("enforces the LRU bound it inherits from MemoryResponseCache", async () => {
    const storage = new FakeAsyncStorage();
    const cache = new AsyncStorageResponseCache({ storage, maxEntries: 2 });
    cache.set("a", entry('W/"a"', "1.0"));
    cache.set("b", entry('W/"b"', "2.0"));
    cache.get("a"); // touch
    cache.set("c", entry('W/"c"', "3.0"));
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.etag).toBe('W/"a"');
  });

  it("clears both halves", async () => {
    const storage = new FakeAsyncStorage();
    const cache = new AsyncStorageResponseCache({ storage });
    cache.set("a", entry('W/"a"', "1.0"));
    await cache.flush();
    cache.clear();
    await cache.flush();
    expect(cache.size).toBe(0);
    expect(storage.items.size).toBe(0);
  });
});
