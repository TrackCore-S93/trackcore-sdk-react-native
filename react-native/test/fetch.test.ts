/**
 * The React Native `fetch` adapter.
 *
 * The two things worth testing are the two things React Native does
 * differently: the body must stay text, and the abort signal must take effect
 * even if the platform ignores it.
 */

import { AbortError, createReactNativeFetch, type FetchLike } from "../src";

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

describe("the adapter leaves the body alone", () => {
  it("never calls .json() on the response it returns", async () => {
    const json = jest.fn();
    const fake: FetchLike = async () => {
      const response = textResponse('{"metric_amount":138.000}');
      Object.defineProperty(response, "json", { value: json });
      return response;
    };
    const adapted = createReactNativeFetch({ fetch: fake });
    const response = await adapted("https://example.test/v1/foods/x", { method: "GET" });
    expect(await response.text()).toBe('{"metric_amount":138.000}');
    expect(json).not.toHaveBeenCalled();
  });

  it("passes the request through without a responseType", async () => {
    let seen: RequestInit | undefined;
    const fake: FetchLike = async (_url, init) => {
      seen = init;
      return textResponse("{}");
    };
    await createReactNativeFetch({ fetch: fake })("https://example.test/", { method: "GET" });
    expect(seen).toBeDefined();
    expect(Object.keys(seen as object)).not.toContain("responseType");
  });

  it("stamps X-TrackCore-Client and keeps the caller's headers", async () => {
    let seen: Record<string, string> = {};
    const fake: FetchLike = async (_url, init) => {
      seen = init.headers as Record<string, string>;
      return textResponse("{}");
    };
    await createReactNativeFetch({ fetch: fake })("https://example.test/", {
      method: "GET",
      headers: { Authorization: "Bearer tc_pk_test_x", Accept: "application/json" },
    });
    expect(seen["X-TrackCore-Client"]).toMatch(/^trackcore-react-native\/\d/);
    expect(seen["Authorization"]).toBe("Bearer tc_pk_test_x");
    expect(seen["Accept"]).toBe("application/json");
  });

  it("does not set User-Agent — React Native's own agent is left alone", async () => {
    let seen: Record<string, string> = {};
    const fake: FetchLike = async (_url, init) => {
      seen = init.headers as Record<string, string>;
      return textResponse("{}");
    };
    await createReactNativeFetch({ fetch: fake })("https://example.test/", { method: "GET" });
    expect(Object.keys(seen)).not.toContain("User-Agent");
  });
});

describe("the abort race", () => {
  it("rejects with an AbortError when the signal fires, even if fetch ignores it", async () => {
    // A `fetch` that never settles and pays no attention to the signal — the
    // shape of an older React Native, a patched polyfill, or a networking
    // library's fetch-alike. Without the race the SDK's ten-second attempt
    // timeout would silently become the platform's sixty-second socket timeout.
    const deaf: FetchLike = () => new Promise<Response>(() => {});
    const controller = new AbortController();
    const pending = createReactNativeFetch({ fetch: deaf })("https://example.test/", {
      method: "GET",
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow(AbortError);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately for a signal that was already aborted", async () => {
    const deaf: FetchLike = () => new Promise<Response>(() => {});
    const controller = new AbortController();
    controller.abort();
    await expect(
      createReactNativeFetch({ fetch: deaf })("https://example.test/", {
        method: "GET",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves normally when the request wins the race", async () => {
    const fake: FetchLike = async () => textResponse('{"ok":true}');
    const controller = new AbortController();
    const response = await createReactNativeFetch({ fetch: fake })("https://example.test/", {
      method: "GET",
      signal: controller.signal,
    });
    expect(await response.text()).toBe('{"ok":true}');
    controller.abort(); // after the fact: must not throw anywhere
  });

  it("propagates a genuine network failure unchanged", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("Network request failed");
    };
    const controller = new AbortController();
    await expect(
      createReactNativeFetch({ fetch: failing })("https://example.test/", {
        method: "GET",
        signal: controller.signal,
      }),
    ).rejects.toThrow("Network request failed");
  });

  it("does not leave an unhandled rejection when an abandoned request later fails", async () => {
    // React Native's dev-mode handler turns an unhandled rejection into a red
    // screen, so abandoning a raced request has to swallow its outcome.
    let reject: ((cause: unknown) => void) | undefined;
    const slow: FetchLike = () =>
      new Promise<Response>((_resolve, rejectFn) => {
        reject = rejectFn;
      });
    const controller = new AbortController();
    const pending = createReactNativeFetch({ fetch: slow })("https://example.test/", {
      method: "GET",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    reject?.(new Error("the socket died later"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("a missing global fetch", () => {
  it("rejects with a message pointing at InitializeCore, not a crash", async () => {
    const adapted = createReactNativeFetch({ fetch: undefined as unknown as FetchLike });
    const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", { value: undefined, configurable: true });
    try {
      const rebuilt = createReactNativeFetch();
      await expect(rebuilt("https://example.test/", {})).rejects.toThrow(/no global `fetch`/);
    } finally {
      if (saved) Object.defineProperty(globalThis, "fetch", saved);
    }
    expect(typeof adapted).toBe("function");
  });
});

describe("the iOS platform cache is kept out of the way", () => {
  /**
   * Found on a simulator, not here. Once iOS NSURLSession holds a stored
   * response for a URL it takes over the conditional headers for that URL, and
   * the SDK's own If-None-Match does not reach the server: a repeat
   * conditional GET came back 200 with a full 5 393-byte body, carrying a
   * fresh X-Request-Id, where Node and curl both got 304. `no-cache` did not
   * help; `no-store` did, because there is then no stored entry.
   *
   * The unit test can only pin the header. `example/device-check/` is what
   * shows it actually changes iOS' behaviour.
   */
  it("sends Cache-Control: no-store on every request", async () => {
    let seen: Record<string, string> = {};
    const fake: FetchLike = async (_url, init) => {
      seen = init.headers as Record<string, string>;
      return textResponse("{}");
    };
    await createReactNativeFetch({ fetch: fake })("https://example.test/", { method: "GET" });
    expect(seen["Cache-Control"]).toBe("no-store");
  });

  it("lets a caller override it, because then the freshness guarantee is theirs", async () => {
    let seen: Record<string, string> = {};
    const fake: FetchLike = async (_url, init) => {
      seen = init.headers as Record<string, string>;
      return textResponse("{}");
    };
    await createReactNativeFetch({ fetch: fake })("https://example.test/", {
      method: "GET",
      headers: { "Cache-Control": "max-age=60" },
    });
    expect(seen["Cache-Control"]).toBe("max-age=60");
  });

  it("does not let a caller override the client stamp", async () => {
    let seen: Record<string, string> = {};
    const fake: FetchLike = async (_url, init) => {
      seen = init.headers as Record<string, string>;
      return textResponse("{}");
    };
    await createReactNativeFetch({ fetch: fake })("https://example.test/", {
      method: "GET",
      headers: { "X-TrackCore-Client": "not-this" },
    });
    expect(seen["X-TrackCore-Client"]).toMatch(/^trackcore-react-native\//);
  });
});
