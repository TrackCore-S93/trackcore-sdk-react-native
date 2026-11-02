/**
 * `createTrackCoreClient` — the client a React Native application constructs.
 *
 * # How this package consumes `@trackcore/sdk`
 *
 * By **composition, as a dependency**. There is no vendored copy of anything.
 * The transport, the two clocks, the retry policy (including the 502 cap), the
 * error mapping onto the closed 37-code enumeration, the lexeme-preserving JSON
 * parser, `Decimal`, the ETag revalidation logic, the model decode and the
 * `Credential` holder are all imported and used unmodified. A `TrackCoreClient`
 * is a thin wrapper over the JavaScript SDK's own `TrackCore` instance.
 *
 * The alternative — sharing source, through a path mapping or a copied `src/` —
 * was rejected for one reason: it makes a second decimal parser *possible*. The
 * moment two trees compile the same file, one of them can be patched for a
 * platform quirk, and the divergence is invisible until a nutrient is wrong
 * eighteen months later. A package boundary makes that impossible rather than
 * discouraged; `test/shared-core.test.ts` additionally asserts that this
 * package's `Decimal`, `Transport` and error classes are **identical object
 * identities** to the JavaScript SDK's, so a stray second copy fails the suite.
 *
 * Metro, not Node, resolves this at build time. The dependency's `main` points
 * at `dist/index.cjs`, a single pre-bundled CommonJS file with zero runtime
 * dependencies, which is the form Metro is happiest with — it needs no
 * `package.json` `exports` support and no ESM interop. The README's
 * "Installation" section covers the monorepo symlink.
 *
 * # What is specialised, and why each one had to be
 *
 * | specialised              | why React Native forced it                          |
 * |--------------------------|-----------------------------------------------------|
 * | the secret-key refusal   | a device is never ambiguous; see `./credentials.ts` |
 * | the `fetch` adapter      | React Native's fetch is a polyfill; see `./fetch.ts`|
 * | the ETag store           | `AsyncStorage` is async and Hermes has no `JSON.rawJSON`; see `./cache.ts` |
 *
 * Nothing else. In particular the retry policy is `@trackcore/sdk`'s
 * `DEFAULT_RETRY_POLICY` verbatim, 502 cap included: a malformed-parameter 502
 * is indistinguishable from an outage and can never succeed on retry, so it
 * gets one retry, while connect failures, timeouts, 408, 429, 503 and 504 get
 * the full budget. A device has *more* reason to respect that than a server
 * does — the budget being burned is a user's battery and a metered connection.
 *
 * # What is deliberately absent
 *
 * No offline queue. No client-side portion scaling, serving normalisation or
 * nutrition summation (SDK-C2, DM-N10) — not as a method that throws, not as a
 * type, not as a TODO. `grounds` lost 12 of 19 nutrients doing exactly that.
 * Scaling is `POST /v1/foods/scale`, server-side, and it is not in this task.
 *
 * No camera, voice or health either. Those are T-113, T-114 and T-119, they are
 * optional peer dependencies by SDK-R2, and a customer who only searches for
 * food must link none of them. `test/surface.test.ts` greps the public surface.
 */

import {
  TrackCore,
  type BarcodeLookup,
  type BatchFoodsOptions,
  type BatchReadResult,
  type CapabilityCatalogue,
  type Diagnostic,
  type FetchLike,
  type Food,
  type GetFoodOptions,
  type ExtractLabelOptions,
  type LabelImage,
  type RecognizeImageOptions,
  type SearchSpeechOptions,
  type LookupBarcodeOptions,
  type ProbeOk,
  type ResponseCache,
  type RetryPolicy,
  type JsonObject,
  type SearchFoodsParams,
  type SearchResults,
  type Transport,
} from "@trackcore/sdk";

import { assertDeviceSafeApiKey } from "./credentials";
import { createReactNativeFetch, VERSION } from "./fetch";

export { VERSION };

/** Where the device SDK points when nothing says otherwise. */
export const DEFAULT_BASE_URL = "https://api.trackcore.dev";

export interface TrackCoreClientOptions {
  /**
   * A **publishable** key: `tc_pk_live_…` or `tc_pk_test_…`.
   *
   * A `tc_sk_` key throws `ConfigurationError` with
   * `reason: "secret_key_in_browser"` from this call, before anything is sent,
   * unconditionally and with no override. See `./credentials.ts`.
   */
  readonly apiKey: string;
  /** Override for a proxy, a staging environment, or a local service. */
  readonly baseUrl?: string | undefined;
  /**
   * Per-attempt timeout. Default 10 000 ms, from `@trackcore/sdk`.
   *
   * On a device this bounds one network attempt on a connection that may be a
   * train tunnel. It is not the whole call: see {@link deadlineMs}.
   */
  readonly timeoutMs?: number | undefined;
  /** Overall budget for a call, retries and backoff included. Default 30 000 ms. */
  readonly deadlineMs?: number | undefined;
  /**
   * Partial overrides for the retry policy. The default is the JavaScript
   * SDK's, 502 cap included; override it only with a reason.
   */
  readonly retry?: Partial<RetryPolicy> | undefined;
  /**
   * ETag revalidation store (SDK-O4). Off unless supplied. Pass
   * `new AsyncStorageResponseCache({ storage: AsyncStorage })` to persist it
   * across launches, or `new MemoryResponseCache()` to keep it in memory.
   *
   * **Revalidation only.** This is not offline support and will not serve a
   * body the server has not just confirmed.
   */
  readonly cache?: ResponseCache | undefined;
  /**
   * A custom `fetch`, for instrumentation or a corporate proxy. It is wrapped
   * by the React Native adapter either way, so the abort race and the
   * text-only body rule still apply.
   */
  readonly fetch?: FetchLike | undefined;
  /** Extra headers on every request. Cannot override `Authorization`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Retry and cache events. Never carries a credential or a user's query —
   * `path` is the path and query only, which on `/v1/foods/search` does include
   * `q`; treat it as user data if you forward it anywhere.
   */
  readonly onDiagnostic?: ((d: Diagnostic) => void) | undefined;
}

/**
 * The device client.
 *
 * Construct one and keep it. It holds no connection and no mutable per-request
 * state, so one instance for the whole application is right; constructing one
 * per screen re-runs the credential check for nothing and throws away the ETag
 * cache if the cache was created alongside it.
 */
export class TrackCoreClient {
  /** `"live"` or `"test"` (PF-K5). */
  readonly environment: "live" | "test";
  /** Always `"publishable"` here. A secret key never gets this far. */
  readonly keyKind: "publishable";

  private readonly inner: TrackCore;

  constructor(options: TrackCoreClientOptions) {
    // FIRST. Before the base URL is validated, before `fetch` is resolved,
    // before anything touches a global. A secret key must not reach a code path
    // that could be persuaded to accept it.
    const parsed = assertDeviceSafeApiKey(options.apiKey);
    this.environment = parsed.environment;
    this.keyKind = "publishable";

    this.inner = new TrackCore({
      apiKey: options.apiKey.trim(),
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      timeoutMs: options.timeoutMs,
      deadlineMs: options.deadlineMs,
      retry: options.retry,
      cache: options.cache,
      fetch: createReactNativeFetch({ fetch: options.fetch }),
      headers: options.headers,
      onDiagnostic: options.onDiagnostic,
      // `@trackcore/sdk` warns when a *secret* key is used in a runtime it
      // cannot classify, and React Native is exactly such a runtime — it has no
      // `process.versions.node`, no document and no self-announcing global, so
      // its detector returns "unknown". That warning can never fire here,
      // because `assertDeviceSafeApiKey` has already refused every secret key
      // above. The hook is pinned to a throw so that if it ever *does* fire,
      // the build fails loudly instead of printing into a console nobody reads.
      warn: (message: string) => {
        throw new Error(
          `[trackcore] unreachable: the shared SDK warned about a credential the device guard ` +
            `should have refused. This is a bug in @trackcore/react-native. ${message}`,
        );
      },
    });
  }

  /** The underlying transport, for the tree-shakeable standalone functions. */
  get transport(): Transport {
    return this.inner.transport;
  }

  readonly foods = {
    /**
     * `GET /v1/foods/search?q=…` (US-1, US-3, US-4, US-5, US-10).
     *
     * No matches is a `200` with `results: []`, never an error. An outage is a
     * `502` and arrives as `DependencyError`. US-10 requires those to be
     * distinguishable, so never render them the same way.
     */
    search: (params: SearchFoodsParams): Promise<SearchResults> => this.inner.foods.search(params),
    /**
     * `GET /v1/foods/{food_id}` (US-1, US-2, US-6).
     *
     * `ResourceError` with code `food_gone` (410) when the provider no longer
     * resolves the id; `resource_not_found` (404) when it was never a TrackCore
     * food id.
     */
    get: (foodId: string, options?: GetFoodOptions): Promise<Food> => this.inner.foods.get(foodId, options),
    /**
     * `GET /v1/foods?ids=a,b,c`, at most 100 (US-5, US-5b).
     *
     * **Read `missing[]` before you act on `found[]`.** Every unresolvable id is
     * in it, in request order, and nothing is silently omitted.
     */
    batch: (ids: readonly string[], options?: BatchFoodsOptions): Promise<BatchReadResult> =>
      this.inner.foods.batch(ids, options),
  };

  readonly barcode = {
    /**
     * `GET /v1/foods/barcode/{code}`. A miss resolves; it does not throw.
     *
     * Camera scanning is `@trackcore/react-native-scanner`, which uses
     * `react-native-camera-kit`. This core does not export it.
     */
    lookup: (code: string, options?: LookupBarcodeOptions): Promise<BarcodeLookup> =>
      this.inner.barcode.lookup(code, options),
  };

  readonly label = {
    /**
     * `POST /v1/label`. Sends a photo and returns the extraction.
     *
     * Does not open a camera. Capture or pick the photo in the app, then pass
     * the bytes here. A photo that is not a label resolves with `food` null.
     */
    extract: (image: LabelImage, options?: ExtractLabelOptions): Promise<JsonObject> =>
      this.inner.label.extract(image, options),
  };

  readonly image = {
    /**
     * `POST /v1/image/food`. Sends a meal photo and returns TrackCore foods.
     * Does not open a camera.
     */
    food: (image: LabelImage, options?: RecognizeImageOptions): Promise<JsonObject> =>
      this.inner.image.food(image, options),
    /**
     * `POST /v1/image/fridge`. Same recognition, for a fridge photo.
     * Requires `ai.fridge`.
     */
    fridge: (image: LabelImage, options?: RecognizeImageOptions): Promise<JsonObject> =>
      this.inner.image.fridge(image, options),
  };

  readonly nlp = {
    /** `POST /v1/nlp` with a transcript. Ten catalog foods. */
    search: (text: string, options?: SearchSpeechOptions): Promise<JsonObject> =>
      this.inner.nlp.search(text, options),
    /**
     * `POST /v1/nlp` with a recording. whisper.cpp transcribes it, then the
     * catalog is searched. Pass bytes the app already recorded.
     */
    fromSpeech: (audio: LabelImage, options?: SearchSpeechOptions): Promise<JsonObject> =>
      this.inner.nlp.fromSpeech(audio, options),
  };

  readonly capabilities = {
    /** `GET /v1/capabilities` (PF-A2). Coming Soon ones are present and `selectable: false`. */
    list: (options?: { signal?: AbortSignal | undefined }): Promise<CapabilityCatalogue> =>
      this.inner.capabilities.list(options),
  };

  /** `GET /healthz`. Liveness only: it touches nothing and proves nothing else. */
  health(options?: { signal?: AbortSignal | undefined }): Promise<ProbeOk> {
    return this.inner.health(options);
  }

  /** `tc_pk_live_…abcd`. Safe to log; the key itself is not reachable from here. */
  describeCredential(): string {
    return this.inner.describeCredential();
  }

  toJSON(): Record<string, unknown> {
    return {
      environment: this.environment,
      keyKind: this.keyKind,
      credential: this.describeCredential(),
    };
  }
}

/** Convenience factory. Identical to `new TrackCoreClient(options)`. */
export function createTrackCoreClient(options: TrackCoreClientOptions): TrackCoreClient {
  return new TrackCoreClient(options);
}
