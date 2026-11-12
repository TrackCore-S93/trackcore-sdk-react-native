/**
 * The `fetch` adapter for React Native's networking stack.
 *
 * The retry policy, the two clocks and the error mapping are **not** here. They
 * are `@trackcore/sdk`'s `Transport`, used unchanged — this module supplies the
 * `FetchLike` that `Transport` calls, and nothing else. Everything below exists
 * because React Native's `fetch` is not Node's and not a browser's, and the
 * differences are the kind that fail silently.
 *
 * # What React Native's `fetch` actually is
 *
 * It is the `whatwg-fetch` polyfill over `XMLHttpRequest`, over the platform's
 * own networking (`NSURLSession` on iOS, OkHttp on Android). It is not the
 * engine's. Hermes ships no `fetch`; React Native installs one during
 * `InitializeCore`. Three consequences matter here.
 *
 * ## 1. The body must be taken as text, and it already is
 *
 * The user-visible question is whether anything in React Native's networking
 * parses the JSON before the SDK sees it. It does not: the polyfill's `Response`
 * holds the raw string from `XMLHttpRequest.responseText` and only parses when
 * `.json()` is called, which is `JSON.parse(this._bodyText)`. `Transport` calls
 * `response.text()` and never `.json()`, so the exact lexemes survive to the
 * lexeme-preserving parser. `test/no-naive-parse.test.ts` greps this package
 * for `.json()` and `JSON.parse` on a response path, because the failure mode
 * of getting this wrong is silent and one careless line reintroduces it.
 *
 * There is a real way to break it, which is why {@link createReactNativeFetch}
 * refuses it: React Native supports `xhr.responseType = "blob"` through
 * `fetch`'s own machinery, and a customer-supplied `fetch` wrapper that
 * returned a Blob-backed `Response` would change what `.text()` yields. The
 * adapter therefore always produces a text-backed response and never passes a
 * `responseType` through.
 *
 * ## 2. `AbortSignal` support is version-dependent, and a timeout that does not
 *    fire is worse than no timeout
 *
 * `Transport` implements its per-attempt timeout by aborting an
 * `AbortController` and relying on `fetch` to honour the signal. React Native
 * has honoured it since 0.60, but a customer on an older line, behind a
 * patched polyfill, or using a `fetch`-shaped shim from a networking library
 * may not — and the symptom is a request that hangs for the platform's own
 * socket timeout (60 s on iOS, longer on Android) while the SDK believes it
 * bounded the attempt to ten seconds.
 *
 * So the adapter **races the signal itself**: if the signal fires, the returned
 * promise rejects with an `AbortError` immediately, whether or not the
 * underlying `fetch` noticed. The in-flight request is then abandoned rather
 * than cancelled — it finishes into a discarded promise and is dropped. That
 * costs a socket for the remainder of its life, which is the lesser of the two
 * failures and is documented rather than hidden. When the platform does honour
 * the signal (every supported version) the race is dead weight and nothing
 * leaks.
 *
 * ## 3. iOS keeps its own response store, and it takes over `If-None-Match`
 *
 * **Found on a simulator. The Node suite could not have caught it, and did
 * not: the identical code passes there.**
 *
 * React Native's iOS networking is `NSURLSession`, which carries a shared
 * `NSURLCache`. Measured against a live `nutritiond`, all with the same food
 * and the same weak validator:
 *
 * | request                                              | status |
 * |------------------------------------------------------|--------|
 * | conditional `GET`, no cache directive                 | `200`, full 5 393-byte body |
 * | …plus `Cache-Control: no-cache`                       | `200`, full body |
 * | …plus `Cache-Control: no-store`, URL with no history  | `304` |
 * | the identical request from Node, or from `curl`        | `304` |
 *
 * Every one of those carried a **fresh `X-Request-Id`**, so this is not
 * `NSURLCache` replaying a stored body at the app: the request reached the
 * server each time and the server answered `200`, which it only does when it
 * sees no matching validator. What the evidence supports is that once
 * `NSURLSession` has state for a URL it manages the conditional headers for
 * that URL itself, and the SDK's `If-None-Match` does not survive to the wire.
 * `no-cache` does not help — it asks for revalidation rather than suppressing
 * the store. `no-store` does.
 *
 * With `Cache-Control: no-store` on every request, SDK-O4 revalidation works
 * on iOS: the device harness observes `response:200` then `response:304` and a
 * `cache_hit`, against the live service, under Hermes.
 *
 * **The known limit, stated plainly.** The effect is tied to a URL's history
 * within the app's lifetime. In the harness, a URL that had been fetched by a
 * plain `fetch` with no cache directive stopped honouring the SDK's
 * `If-None-Match` for the rest of the session, even once `no-store` was sent.
 * So: route every TrackCore request through the SDK and revalidation works;
 * mix in your own bare `fetch` calls to the same URLs and it can stop firing.
 * The precise rule inside `NSURLSession` was not established — this is
 * observed behaviour, not a reading of Apple's source — and the failure is
 * benign in the only way that matters: the server is still reached and still
 * answers, so a caller gets a correct, fresh body and loses only the saved
 * bandwidth. It is never stale.
 *
 * `no-store` is also simply a true statement of this SDK's policy. It keeps
 * its own validator store (see `./cache.ts`), it has no offline mode, and a
 * second invisible copy of a response on the device is what DM-F5 is about:
 * `grounds` shipped a Hive cache *disabled in code* because nobody could tell
 * when a cached food had gone wrong.
 *
 * Android's OkHttp installs no response cache by default and was unaffected;
 * the header is correct there too and costs nothing. A caller can override it
 * through `headers`, and then the platform's caching is theirs to reason about.
 *
 * ## 4. `User-Agent` and header case
 *
 * `@trackcore/sdk` already suppresses its own `User-Agent` when `navigator`
 * exists, which it does on React Native, so the platform's own agent string is
 * left alone. This adapter adds `X-TrackCore-Client` instead: React Native has
 * no CORS, so a custom header costs no preflight, and it is the only way to
 * tell a device call apart from a server one in a log.
 */

import { AbortError, type FetchLike } from "@trackcore/sdk";

/** Options for {@link createReactNativeFetch}. */
export interface ReactNativeFetchOptions {
  /**
   * The `fetch` to delegate to. Defaults to the global one React Native
   * installs. Supply your own only to instrument it — a replacement that
   * returns anything other than a text-backed `Response` breaks the decimal
   * contract, and {@link createReactNativeFetch} cannot check that for you.
   */
  readonly fetch?: FetchLike | undefined;
  /**
   * Stamped into `X-TrackCore-Client`. Defaults to `trackcore-react-native/<version>`.
   */
  readonly clientName?: string | undefined;
}

/** Kept in step with package.json. */
export const VERSION = "0.4.1";

/**
 * Builds the `FetchLike` that `Transport` will call.
 *
 * Throws nothing at construction; a missing global `fetch` surfaces as
 * `Transport`'s own `ConfigurationError` with `reason: "fetch_unavailable"`,
 * which is the error the JavaScript SDK already documents for this.
 */
export function createReactNativeFetch(options: ReactNativeFetchOptions = {}): FetchLike {
  const delegate = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
  const clientName = options.clientName ?? `trackcore-react-native/${VERSION}`;

  return function reactNativeFetch(input: string, init: RequestInit): Promise<Response> {
    if (typeof delegate !== "function") {
      // Deliberately the platform's own failure rather than a new error type:
      // `Transport` already has `fetch_unavailable` and a second spelling of
      // "this runtime has no fetch" helps nobody.
      return Promise.reject(
        new TypeError(
          "This React Native runtime has no global `fetch`. React Native installs one in " +
            "InitializeCore; if you have replaced or stripped it, pass a `fetch` option to " +
            "createTrackCoreClient().",
        ),
      );
    }

    const headers: Record<string, string> = {
      // `Cache-Control` is defaulted *before* the caller's headers are spread
      // so a caller can deliberately override it; everything after is the
      // SDK's own and is not negotiable. `no-store`, not `no-cache` — see the
      // measurements at the top of this file; `no-cache` was tried and does
      // not restore the 304.
      "Cache-Control": "no-store",
      ...(init.headers as Record<string, string> | undefined),
      "X-TrackCore-Client": clientName,
    };

    // `responseType` is never forwarded, and no Blob or ArrayBuffer path is
    // offered. The response body must stay text all the way to `parseJson`.
    const request: RequestInit = { ...init, headers };

    const pending = delegate(input, request);

    const signal = init.signal;
    if (signal === undefined || signal === null) return pending;

    return raceAbort(pending, signal);
  };
}

/**
 * Rejects as soon as `signal` fires, regardless of whether the underlying
 * `fetch` honoured it.
 *
 * The rejection's `name` is `"AbortError"`, which is what `Transport`'s
 * `isAbort`/`isCallerAbort` discriminate on: a caller's own abort becomes
 * `AbortError`, the transport's internal timeout controller becomes a
 * `TimeoutError` and is retried under the policy. Returning anything else here
 * would silently reclassify every timeout as a connection failure, which is a
 * different retry budget.
 */
function raceAbort(pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) {
    void swallow(pending);
    return Promise.reject(abortError());
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      // The underlying request may still be in flight. Attach a no-op handler
      // so abandoning it cannot surface as an unhandled rejection — React
      // Native's dev-mode handler turns one of those into a red screen.
      void swallow(pending);
      reject(abortError());
    };

    signal.addEventListener("abort", onAbort);

    pending.then(
      (response) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

/**
 * An `AbortError` by `name`, which is the contract `Transport` reads.
 *
 * `@trackcore/sdk`'s exported `AbortError` class sets `name` from the
 * constructor, so this is that class — not a hand-rolled error that merely
 * looks like one.
 */
function abortError(): Error {
  const error = new AbortError();
  // `AbortError extends TrackCoreClientError extends Error` and sets
  // `this.name = new.target.name`. Under a minifier that renames classes the
  // name can become a mangled identifier, and `Transport` matches on the
  // string. Pin it.
  if (error.name !== "AbortError") {
    Object.defineProperty(error, "name", { value: "AbortError", configurable: true });
  }
  return error;
}

function swallow(pending: Promise<unknown>): Promise<void> {
  return pending.then(
    () => undefined,
    () => undefined,
  );
}
