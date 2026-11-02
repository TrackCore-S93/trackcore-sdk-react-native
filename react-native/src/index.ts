/**
 * TrackCore React Native SDK — the public surface (T-111).
 *
 * # Read this first if you are looking for a type
 *
 * Almost everything here is **re-exported from `@trackcore/sdk`**, the
 * JavaScript SDK, which this package depends on rather than reimplements. That
 * is deliberate and it is the single most important design decision in the
 * package: there is exactly one `Decimal`, one lexeme-preserving JSON parser,
 * one retry policy, one error enumeration and one credential holder in the
 * product, and this SDK is a consumer of them. `test/shared-core.test.ts`
 * asserts the object identities.
 *
 * Three things are specialised, each because React Native forced it, and each
 * documented at the top of its own file:
 *
 *   `./credentials.ts`  a secret key is refused **unconditionally** — there is
 *                       no "might be a server" case on a device, and the
 *                       refusal reads no global, which is how it avoids
 *                       BUG-022's class of hole
 *   `./fetch.ts`        React Native's `fetch` is a polyfill over
 *                       `XMLHttpRequest`; the body stays text, and the abort
 *                       signal is raced rather than trusted
 *   `./cache.ts`        `AsyncStorage` is async where `ResponseCache` is sync,
 *                       and Hermes has no `JSON.rawJSON`, so a stored body
 *                       needs a lossless codec
 *
 * # Models
 *
 * The model types below are re-exported, not redeclared. They are
 * `@trackcore/sdk`'s **placeholders**, which T-107 regenerates from
 * `contracts/openapi.yaml` under a CI parity gate; their names already match
 * the spec's schema names (`SearchResults`, `BatchReadResult`,
 * `CapabilityCatalogue`, `ProbeOk`) so generated output drops straight in.
 *
 * **This package hand-writes none of them.** Re-exporting is how it stays that
 * way: when T-107 lands, this file needs no edit, and there is no second place
 * for a nutrient to be typed `number` instead of `Decimal`.
 *
 * # Not here, and not coming here
 *
 * No portion scaling, serving normalisation or nutrition summation (SDK-C2,
 * DM-N10) — server-side only. No offline queue (decided 2026-10-23). Camera
 * (T-113), voice (T-114) and health (T-119) are separate optional sub-packages
 * so that a customer who only searches for food links no native code (SDK-R2).
 */

// ---------------------------------------------------------------------------
// The device client
// ---------------------------------------------------------------------------
export {
  TrackCoreClient,
  createTrackCoreClient,
  DEFAULT_BASE_URL,
  VERSION,
  type TrackCoreClientOptions,
} from "./client";

// ---------------------------------------------------------------------------
// The specialisations
// ---------------------------------------------------------------------------
export { assertDeviceSafeApiKey } from "./credentials";
export { createReactNativeFetch, type ReactNativeFetchOptions } from "./fetch";
export {
  AsyncStorageResponseCache,
  encodeBody,
  decodeBody,
  type AsyncStorageLike,
  type AsyncStorageResponseCacheOptions,
} from "./cache";
export {
  detectReactNativeRuntime,
  describeRuntime,
  type JsEngine,
  type ReactNativeRuntimeInfo,
} from "./environment";

// ---------------------------------------------------------------------------
// The numeric contract — one `Decimal` in the product, imported, never copied
// ---------------------------------------------------------------------------
export { Decimal, isDecimal } from "@trackcore/sdk";

// ---------------------------------------------------------------------------
// Errors (SDK-C3). The closed 37-code enumeration, unchanged.
// ---------------------------------------------------------------------------
export {
  TrackCoreError,
  TrackCoreAPIError,
  TrackCoreClientError,
  RequestError,
  AuthenticationError,
  AuthorizationError,
  ResourceError,
  RateLimitError,
  ServerError,
  DependencyError,
  MaintenanceError,
  ConfigurationError,
  ConnectionError,
  TimeoutError,
  AbortError,
  ProtocolError,
  ValidationError,
  isTrackCoreError,
  isAPIError,
  isErrorOfCode,
  ALL_ERROR_CODES,
  ERROR_CODES,
  errorCodeSpec,
  isErrorCode,
  type APIErrorInit,
  type ConfigurationErrorReason,
  type ErrorCodeSpec,
  type ErrorFields,
  type RetryAfterPolicy,
  type TrackCoreErrorCategory,
  type TrackCoreErrorCode,
  type TrackCoreErrorField,
} from "@trackcore/sdk";

// ---------------------------------------------------------------------------
// Tree-shakeable resource functions (SDK-W5). `TrackCoreClient` satisfies
// `HasTransport`, so these work against it directly.
// ---------------------------------------------------------------------------
export {
  searchFoods,
  getFood,
  batchFoods,
  lookupBarcode,
  BATCH_MAX_IDS,
  QUERY_MAX_LENGTH,
  QUERY_MIN_LENGTH,
  type BatchFoodsOptions,
  type GetFoodOptions,
  type HasTransport,
  type LookupBarcodeOptions,
  type SearchFoodsParams,
} from "@trackcore/sdk";

// ---------------------------------------------------------------------------
// Models — T-107 regenerates these in `@trackcore/sdk`; none is written here
// ---------------------------------------------------------------------------
export type {
  BarcodeFormat,
  BarcodeLookup,
  BarcodeStatus,
  BatchReadResult,
  Capability,
  CapabilityCatalogue,
  CarbohydrateBasis,
  DataQuality,
  EnergyReconciliation,
  Food,
  FoodId,
  FoodType,
  NutrientUnit,
  NutrientValue,
  NutritionDocument,
  ProbeOk,
  Provenance,
  ProvenanceSource,
  ReconciliationBasis,
  ReconciliationReason,
  SearchResults,
  Serving,
  ServingId,
  Timestamp,
} from "@trackcore/sdk";

// ---------------------------------------------------------------------------
// Transport, retry and caching primitives
// ---------------------------------------------------------------------------
export {
  Transport,
  MemoryResponseCache,
  DEFAULT_RETRY_POLICY,
  backoffDelay,
  decideRetry,
  parseRetryAfter,
  type AttemptOutcome,
  type CacheEntry,
  type Diagnostic,
  type FetchLike,
  type RequestOptions,
  type ResponseCache,
  type RetryContext,
  type RetryDecision,
  type RetryPolicy,
  type SuccessfulResponse,
  type TransportOptions,
} from "@trackcore/sdk";

// ---------------------------------------------------------------------------
// Credentials and the lexeme-preserving parser
// ---------------------------------------------------------------------------
/*
 * `Credential` is **not** re-exported, and neither are `checkCredential`,
 * `detectRuntime` or the JavaScript SDK's own `TrackCore` class.
 *
 * All four are the browser-versus-server machinery, and on React Native that
 * machinery reports `"unknown"` — no `process.versions.node`, no document, no
 * self-announcing global — which means it *warns* about a secret key instead of
 * refusing it. Re-exporting `Credential.create` alongside `Transport` would
 * therefore ship a two-line bypass of this SDK's one unconditional rule.
 *
 * `parseApiKey` is pure: it reads a string and returns its kind, environment,
 * prefix and last four characters. No environment, no decision, nothing to
 * bypass. It is exported because a settings screen validating a pasted key
 * should not have to write the regex again.
 */
export { parseApiKey, type KeyEnvironment, type KeyKind, type ParsedApiKey } from "@trackcore/sdk";

export {
  parseJson,
  parseStrict,
  hasNativeSourceAccess,
  JsonParseError,
  type JsonObject,
  type JsonValue,
} from "@trackcore/sdk";
