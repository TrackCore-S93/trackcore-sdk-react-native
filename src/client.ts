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
  type NlpResult,
  type Transport,
  type DayParams,
  type RangeParams,
  type LogFoodParams,
  type EditPortionParams,
  type CreateMealParams,
  type EditMealParams,
  type CopyParams,
  type CreateCustomFoodParams,
  type CreateRecipeParams,
  type DailyNutrition,
  type DiaryMeals,
  type DiaryRange,
  type DiaryMeal,
  type LoggedFood,
  type CardList,
  type DeletionReceipt,
  type ReorderResult,
  type CopyResult,
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

  /**
   * Attributes every **subsequent** request to one of your end users (D-012).
   *
   * `externalId` is your app's own identifier for the signed-in person — a
   * Firebase UID, a row id, a ULID — not a TrackCore one. There is no "create
   * user" call to await first: the gateway upserts the matching `app_user` row
   * the first time it sees the pair `(your customer id, this id)`, so this is a
   * local assignment that stores a string and returns. Call it wherever the app
   * learns who is signed in — a `useEffect` on the auth state, the resolution
   * of a restored session — and `clearUser()` at sign-out.
   *
   * ```ts
   * auth().onAuthStateChanged((user) => {
   *   if (user) client.setUser(user.uid);
   *   else client.clearUser();
   * });
   * ```
   *
   * From here on every request **this client** makes carries
   * `X-External-Id: <externalId>`: the food reads, the label, image and NLP
   * posts, the revalidating conditional reads that come back `304`, and
   * `health()`. The header is written once in `@trackcore/sdk`'s transport
   * rather than per method, which is why there is no call that can forget it.
   * Calling this again switches user; a refused id leaves the previous one in
   * place, so a bad call can never silently sign somebody out.
   *
   * Throws `ConfigurationError` synchronously, before anything is sent, when
   * the id is one the gateway would refuse — padded, empty, over 255 Unicode
   * code points — or one an HTTP header in JavaScript cannot carry unchanged,
   * which is this SDK's own extra rule. `reason` names the broken rule. The
   * rules, and the long argument for the ASCII one, live in `@trackcore/sdk`'s
   * `src/identity.ts`; this package deliberately does not restate them, because
   * three SDKs enforcing "the same" rules from three sources is how they stop
   * being the same. `assertValidExternalId` is re-exported from `../src/index`
   * if you want the same check at a sign-in form's boundary.
   *
   * **The ETag cache is not cleared on a user switch**, and does not need to
   * be. Everything this SDK caches is catalogue data — a food's nutrition is
   * identical for every end user — and nothing user-scoped is written to
   * `AsyncStorage` at all. Clearing it would throw away a device's warm cache
   * on every sign-in for no benefit, and on a metered connection that is a
   * cost somebody pays. The Flutter SDK made the same call for the same
   * reason; if that ever stops being true, all three change together.
   */
  setUser(externalId: string): void {
    this.inner.setUser(externalId);
  }

  /**
   * Stops attributing requests to an end user. This is sign-out.
   *
   * The header is then **absent**, not blank — and the two are *the same
   * thing* to the gateway, which is worth stating precisely because this
   * comment used to claim the opposite. `provisionUser`
   * (`services/gateway/internal/httpx/guard.go`) reads the header with Go's
   * `Header.Get`, which answers `""` for a header that is missing and for one
   * that is present and empty alike, `net/textproto` having already stripped
   * the surrounding whitespace. Both take the early return and provision
   * nobody. Neither is a `400`.
   *
   * Omitting it entirely is still what this SDK does, and is still the safer
   * of the two: a signed-out request then has exactly one shape on the wire,
   * it is what the gateway's own contract comment asks for, and it is the
   * behaviour that stays correct if the blank case is ever tightened to a
   * `400`. Safe to call when no user was ever set.
   *
   * This is the only way to clear. `setUser(null)` throws rather than signing
   * the user out — from untyped JavaScript that would otherwise turn a bug in
   * the caller's auth plumbing into silently unattributed traffic.
   */
  clearUser(): void {
    this.inner.clearUser();
  }

  /**
   * The end user requests are currently attributed to, or `null` when none is
   * set.
   *
   * Exactly the string passed to {@link setUser}; TrackCore's internal id is
   * never spoken aloud (PF-T3, DM-T2). Named the same in the JavaScript and
   * Flutter SDKs (SDK-C9).
   */
  get externalId(): string | null {
    return this.inner.externalId;
  }

  /**
   * Sets the end-user session token this device carries (T-126).
   *
   * **This is how a React Native app reaches one end user's diary.** A
   * publishable key alone cannot: it says which customer, not which person, and
   * the gateway answers `403 user_scope_violation` to a diary call made with
   * one. The token says which person.
   *
   * It is minted by **your own backend**, not here — `auth.createSession`
   * requires a secret key, which must never ship in an app binary. The shape
   * is:
   *
   * ```ts
   * // your backend, with the secret key
   * const { session_token } = await serverClient.auth.createSession({ externalId: uid });
   *
   * // the device, with the publishable key
   * client.setSession(session_token);
   * await client.diary.day({ date: todayLocal });
   * ```
   *
   * On `401 session_expired`, ask your backend for a fresh token and call this
   * again. The SDK cannot refresh for you: it has no route to your backend, and
   * a device able to mint its own replacement would be a device able to mint
   * one for anybody.
   *
   * Until OQ-10 is settled this flow requires every mobile customer to run a
   * backend. That is a product question, not a limitation of this method.
   */
  setSession(sessionToken: string): void {
    this.inner.setSession(sessionToken);
  }

  /** Clears the session token. The client is then scoped to no end user. */
  clearSession(): void {
    this.inner.clearSession();
  }

  /** The session token currently carried, or `null`. */
  get sessionToken(): string | null {
    return this.inner.sessionToken;
  }

  /**
   * One end user's food log. Needs `setSession` on a device, or `setUser` when
   * this client runs somewhere a secret key is safe.
   */
  readonly diary = {
    /** `GET /v1/diary/day`. Empty days are a 200 with zeroes, never a 404. */
    day: (params: DayParams): Promise<DailyNutrition> => this.inner.diary.day(params),
    /** `GET /v1/diary/meals`. Entries carry no food snapshot — see the JS SDK. */
    meals: (params: DayParams): Promise<DiaryMeals> => this.inner.diary.meals(params),
    /** `GET /v1/diary/range`. Inclusive, gaps zeroed, capped at 366 days. */
    range: (params: RangeParams): Promise<DiaryRange> => this.inner.diary.range(params),
    /** `POST /v1/diary/entries`. Stores a full snapshot of the food (P-002). */
    log: (params: LogFoodParams): Promise<LoggedFood> => this.inner.diary.log(params),
    /** `PATCH /v1/diary/entries/{id}`. Resolved from the snapshot, no refetch. */
    editPortion: (params: EditPortionParams): Promise<LoggedFood> => this.inner.diary.editPortion(params),
    /** `DELETE /v1/diary/entries/{id}`. */
    deleteEntry: (entryId: string, options?: { signal?: AbortSignal }): Promise<DeletionReceipt> =>
      this.inner.diary.deleteEntry(entryId, options),
    /** `POST /v1/diary/entries/reorder`. Name every entry in the meal. */
    reorder: (params: { mealId: string; entryIds: readonly string[]; signal?: AbortSignal }): Promise<ReorderResult> =>
      this.inner.diary.reorder(params),
    /** `POST /v1/diary/meals`. Same minute merges and returns 200 (DM-M1). */
    createMeal: (params: CreateMealParams): Promise<DiaryMeal> => this.inner.diary.createMeal(params),
    /** `PATCH /v1/diary/meals/{id}`. Moves the meal, not the entries in it. */
    editMeal: (params: EditMealParams): Promise<DiaryMeal> => this.inner.diary.editMeal(params),
    /** `DELETE /v1/diary/meals/{id}`. Takes its entries with it. */
    deleteMeal: (mealId: string, options?: { signal?: AbortSignal }): Promise<DeletionReceipt> =>
      this.inner.diary.deleteMeal(mealId, options),
    /** `POST /v1/diary/meals/{id}/copy`. Copies keep the original's snapshot. */
    copyMeal: (mealId: string, params: CopyParams & { idempotencyKey?: string }): Promise<CopyResult> =>
      this.inner.diary.copyMeal(mealId, params),
    /** `POST /v1/diary/day/copy`. */
    copyDay: (params: CopyParams & { localDate: string; idempotencyKey?: string }): Promise<CopyResult> =>
      this.inner.diary.copyDay(params),
    /** `DELETE /v1/diary/day`. Clearing an empty day is a 200 with 0. */
    clearDay: (params: { date: string; signal?: AbortSignal }): Promise<DeletionReceipt> =>
      this.inner.diary.clearDay(params),
    /** `GET /v1/diary/favourites`. Cards render without a second request. */
    favourites: (options?: { limit?: number; signal?: AbortSignal }): Promise<CardList> =>
      this.inner.diary.favourites(options),
    /** `POST /v1/diary/favourites/{food_id}`. Starring twice is fine. */
    addFavourite: (foodId: string, options?: { signal?: AbortSignal }): Promise<unknown> =>
      this.inner.diary.addFavourite(foodId, options),
    /** `DELETE /v1/diary/favourites/{food_id}`. */
    removeFavourite: (foodId: string, options?: { signal?: AbortSignal }): Promise<DeletionReceipt> =>
      this.inner.diary.removeFavourite(foodId, options),
    /** `GET /v1/diary/recents`. Written by logging; capped at 50, LRU evicted. */
    recents: (options?: { limit?: number; signal?: AbortSignal }): Promise<CardList> =>
      this.inner.diary.recents(options),
    /** `GET /v1/diary/foods/search`. The end user's own foods, not the provider's. */
    searchOwnFoods: (params: { q: string; limit?: number; signal?: AbortSignal }): Promise<unknown> =>
      this.inner.diary.searchOwnFoods(params),
  };

  // There is deliberately NO `auth` namespace here.
  //
  // `POST /v1/auth/session` requires a secret key, and this client refuses to
  // be constructed with one — `assertDeviceSafeApiKey` throws, and no setting
  // disables it. So a `createSession` method on this class could never be
  // reached: the only client that can call it is one that cannot exist.
  //
  // Exposing it anyway would be worse than omitting it. A developer would find
  // the method, call it, and get a ConfigurationError from the *constructor*
  // rather than from the thing they were trying to do.
  //
  // Mint the token on your own server with `@trackcore/sdk`, then hand it here
  // with `setSession`. That split is the point of the design, not a gap in it.
  //
  // The same goes for `users` — `DELETE /v1/users/{external_id}`, the GDPR
  // erasure (PF-T5). It needs a secret key for the same reason: the most
  // destructive call in the API must not be reachable with a credential that
  // ships inside an app binary. When your user deletes their account, your
  // backend calls `serverClient.users.delete(uid)` with `@trackcore/sdk`.

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
    /**
     * The end user's own foods. Under `foods` rather than a namespace of its
     * own because a custom food **is** a food: it comes back in the same shape
     * and `foods.get` resolves one (DM-F6).
     */
    custom: {
      /** `POST /v1/foods/custom`. Nutrient values must be numbers, not strings. */
      create: (params: CreateCustomFoodParams): Promise<Food> =>
        this.inner.foods.custom.create(params),
      /**
       * `DELETE /v1/foods/custom/{food_id}`. Past diary entries that used it
       * keep working — an entry stores a copy of the food, not a reference.
       */
      delete: (foodId: string, options?: { signal?: AbortSignal }): Promise<DeletionReceipt> =>
        this.inner.foods.custom.delete(foodId, options),
    },
    /** `POST /v1/foods/recipes`. Nutrition is summed server-side, losing nothing. */
    recipes: {
      create: (params: CreateRecipeParams): Promise<Food> =>
        this.inner.foods.recipes.create(params),
    },
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
    /**
     * `POST /v1/nlp` with a transcript. The sentence comes back split into
     * items, each resolved to a food, a serving and the nutrition for the
     * spoken quantity, ready for a "your meal" screen and `diary.log`.
     */
    search: (text: string, options?: SearchSpeechOptions): Promise<NlpResult> =>
      this.inner.nlp.search(text, options),
    /**
     * `POST /v1/nlp` with a recording. whisper.cpp transcribes it, then the
     * catalog is searched. Pass bytes the app already recorded.
     */
    fromSpeech: (audio: LabelImage, options?: SearchSpeechOptions): Promise<NlpResult> =>
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
