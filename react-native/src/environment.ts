/**
 * Runtime *diagnostics*. **Not a security control.**
 *
 * Read `./credentials.ts` first. The secret-key refusal in this SDK reads no
 * global at all, and nothing in this file may ever be consulted by it —
 * BUG-022 is what happens when a credential decision depends on a global that
 * a bundler, a polyfill preset or a test harness can set.
 *
 * What this *is* for:
 *
 *   - telling a developer which JSON parser path is live, so the decimal
 *     contract is an observation rather than an assumption (see below);
 *   - the Expo Go groundwork T-115 builds on. Expo Go cannot load the native
 *     modules the camera, voice and health sub-packages need (SDK-R3), and the
 *     requirement is a *named error pointing at development builds*, not a
 *     crash. T-115 owns that error and the config plugin; this file only
 *     answers the question it will ask.
 *
 * Nothing here changes behaviour. Every field is reported, never enforced.
 */

import { hasNativeSourceAccess } from "@trackcore/sdk";

/** Which JavaScript engine the bundle is running on, as far as it will say. */
export type JsEngine = "hermes" | "jsc" | "v8" | "node" | "unknown";

export interface ReactNativeRuntimeInfo {
  /** `true` when the fetch-standard globals the transport needs are present. */
  readonly hasFetch: boolean;
  /** `true` when `AbortController` exists. See `./fetch.ts` for why it matters. */
  readonly hasAbortController: boolean;
  readonly engine: JsEngine;
  /** `navigator.product === "ReactNative"`. Informational only. */
  readonly isReactNative: boolean;
  /**
   * A *guess* that this is the Expo Go sandbox app rather than a development
   * build. Expo Go reports an `expo` app ownership through `expo-constants`,
   * which this package does not depend on, so the signal here is weaker than
   * the one T-115 will use. Never branch on it for correctness.
   */
  readonly looksLikeExpoGo: boolean;
  /**
   * Which `parseJson` path `@trackcore/sdk` selected at load time.
   *
   * `"native-source"` is the ES2025 `JSON.parse` reviver with `context.source`.
   * `"portable"` is the hand-written lexeme-preserving parser.
   *
   * **Both preserve the lexeme exactly** — that is the point of there being two
   * — so this is not a correctness switch. It is published because "the fast
   * path silently stopped firing" and "the parser silently stopped preserving"
   * look identical from the outside unless you can read this. On Hermes today
   * the answer is `"portable"`.
   */
  readonly jsonParser: "native-source" | "portable";
}

function globalValue(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

function detectEngine(): JsEngine {
  if (globalValue("HermesInternal") !== undefined) return "hermes";
  const process = globalValue("process") as { versions?: { node?: unknown; v8?: unknown } } | undefined;
  if (process && typeof process.versions?.node === "string") return "node";
  if (process && typeof process.versions?.v8 === "string") return "v8";
  // React Native on iOS without Hermes is JavaScriptCore. It announces nothing,
  // so this is an inference from "React Native, but not Hermes", not a probe.
  const navigatorRef = globalValue("navigator") as { product?: unknown } | undefined;
  if (navigatorRef?.product === "ReactNative") return "jsc";
  return "unknown";
}

/** Snapshot the runtime. Cheap, side-effect free, safe to call per render. */
export function detectReactNativeRuntime(): ReactNativeRuntimeInfo {
  const navigatorRef = globalValue("navigator") as { product?: unknown } | undefined;
  const expoGlobal = globalValue("expo") as { modules?: unknown } | undefined;
  const nativeModules = globalValue("__turboModuleProxy");

  return Object.freeze({
    hasFetch: typeof globalValue("fetch") === "function",
    hasAbortController: typeof globalValue("AbortController") === "function",
    engine: detectEngine(),
    isReactNative: navigatorRef?.product === "ReactNative",
    // Expo Go preloads the whole Expo module registry; a bare development build
    // of an app that does not use Expo does not. It is suggestive, not proof.
    looksLikeExpoGo: expoGlobal !== undefined && nativeModules === undefined,
    jsonParser: hasNativeSourceAccess ? "native-source" : "portable",
  });
}

/**
 * A one-line summary for a bug report or a dev-menu screen.
 *
 * Contains no credential, no query and no user data — it is all engine facts.
 */
export function describeRuntime(info = detectReactNativeRuntime()): string {
  return (
    `engine=${info.engine} reactNative=${info.isReactNative} fetch=${info.hasFetch} ` +
    `abortController=${info.hasAbortController} jsonParser=${info.jsonParser}` +
    (info.looksLikeExpoGo ? " expoGo=likely" : "")
  );
}
