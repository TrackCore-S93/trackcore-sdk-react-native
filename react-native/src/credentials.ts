/**
 * The secret-key refusal, specialised for a device (SDK-W3).
 *
 * # Why this file exists at all, when `@trackcore/sdk` already has one
 *
 * It does not reimplement credential handling. Parsing, classification, the
 * `Credential` holder that keeps the key in a closure, and the
 * `ConfigurationError` type all come from `@trackcore/sdk` unchanged. What is
 * specialised here is one thing: **the decision**.
 *
 * The JavaScript SDK has to decide, at runtime, whether the code it is inside
 * is a server or a browser, because the same `import` line compiles for both.
 * That decision is genuinely hard — `src/environment.ts` over there reads four
 * classes of signal and still has an "unknown" outcome that only warns.
 *
 * React Native has no such ambiguity. **Every React Native bundle runs on a
 * device, inside an application binary a user installed.** A `.jsbundle` is a
 * plain file inside an `.ipa` or an `.apk`; `unzip` and `strings` are the whole
 * attack. There is no deployment of this package where a secret key is safe, so
 * there is nothing to detect and no reason to consult the environment.
 *
 * That is also precisely how this avoids **BUG-022**. That bug is an *ordering*
 * defect in a multi-signal detector: a bundler-shimmed `process.versions.node`
 * is tested before `WorkerGlobalScope`, so a browser Web Worker classifies as a
 * server and a `tc_sk_` key is accepted. The hole is not in any one signal —
 * it is in having signals at all, because every signal is a global that
 * something else in the bundle can set.
 *
 * The code below reads **no global**. Not `process`, not `navigator`, not
 * `global.HermesInternal`, not `__DEV__`. The refusal is a function of the key
 * string and nothing else, so there is no shim, polyfill, mock, test harness or
 * malicious module that can move it. `detectReactNativeRuntime()` in
 * `./environment.ts` does read globals, and it is deliberately **not** on this
 * path — it exists for Expo Go diagnostics (T-115) and must never be consulted
 * here. `test/credentials.test.ts` asserts both halves.
 *
 * # There is no bypass, and no "unknown" branch
 *
 * The JavaScript SDK warns-and-continues when it cannot classify the runtime,
 * because refusing there would break server runtimes that do not exist yet.
 * That reasoning does not transfer: there is no future React Native that is not
 * a device. So this throws, always, with no escape hatch and no environment
 * variable. Both of this customer's existing apps shipped an extractable key;
 * a flag is how the third one would.
 */

import { ConfigurationError, parseApiKey, type ParsedApiKey } from "@trackcore/sdk";

/**
 * Refuses a secret key. Unconditional.
 *
 * Throws `ConfigurationError` with:
 *   - `reason: "api_key_missing"`     — nothing was supplied
 *   - `reason: "api_key_malformed"`   — not a TrackCore credential
 *   - `reason: "secret_key_in_browser"` — a `tc_sk_` key, on a device
 *
 * The third reason keeps the JavaScript SDK's spelling on purpose. SDK-W3 names
 * one condition, customers branch on `err.reason`, and inventing
 * `secret_key_on_device` here would mean a cross-platform codebase has to
 * handle two strings for one mistake. The *message* says "device"; the
 * *identifier* is shared. `test/credentials.test.ts` pins it.
 *
 * @returns the parsed, publishable credential's public facts. Never the key.
 */
export function assertDeviceSafeApiKey(apiKey: unknown): ParsedApiKey {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new ConfigurationError(
      "api_key_missing",
      "No TrackCore API key was supplied. Pass `apiKey` to createTrackCoreClient(). " +
        "On a device this must be a publishable key (tc_pk_live_… or tc_pk_test_…).",
    );
  }

  const parsed = parseApiKey(apiKey.trim());
  if (parsed === null) {
    // The rejected value is a credential, so its shape is described and the
    // value itself never appears here or in any log line (PF-K8, SDK-C7).
    throw new ConfigurationError(
      "api_key_malformed",
      "The TrackCore API key is not in a recognised format. A publishable key looks like " +
        "`tc_pk_live_…`. The value supplied is not shown here because it is a credential.",
    );
  }

  if (parsed.kind === "secret") {
    throw new ConfigurationError(
      "secret_key_in_browser",
      `A TrackCore secret key (${parsed.prefix}_…${parsed.last4}) was used in a React Native ` +
        `application. Every React Native bundle ships inside an application binary a user ` +
        `installs, and a JavaScript bundle inside an .ipa or an .apk is readable with unzip ` +
        `and strings. This key must be treated as compromised: revoke it and issue a new one. ` +
        `Use a publishable key (tc_pk_${parsed.environment}_…) in the app and keep the secret ` +
        `key on your own server. ` +
        `No setting disables this check — not in development, not in a simulator, and not ` +
        `behind a flag, because the bundle that reaches a user is built from the same code.`,
    );
  }

  return parsed;
}
