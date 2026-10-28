/**
 * The secret-key refusal (SDK-W3), and the BUG-022 hole it must not inherit.
 *
 * BUG-022 is an *ordering* defect in a multi-signal runtime detector: a
 * bundler-shimmed `process.versions.node` is tested before `WorkerGlobalScope`,
 * so a browser Web Worker classifies as a server and a `tc_sk_` key is
 * accepted. The lesson is not "put the worker test first" — it is that a
 * credential decision which consults globals can be moved by whatever else is
 * in the bundle.
 *
 * So the tests below do not check an ordering. They poison every global the
 * JavaScript SDK's detector reads — all at once, in every combination that
 * would flip it to "server" — and assert the refusal does not move.
 */

import { assertDeviceSafeApiKey, ConfigurationError, parseApiKey } from "../src";

/** Syntactically valid, structurally inert: 48 characters of filler. */
const SECRET = `tc_sk_live_${"a".repeat(48)}`;
const SECRET_TEST = `tc_sk_test_${"b".repeat(48)}`;
const PUBLISHABLE = `tc_pk_live_${"c".repeat(48)}`;
const PUBLISHABLE_TEST = `tc_pk_test_${"d".repeat(48)}`;

const GLOBALS = globalThis as unknown as Record<string, unknown>;

/**
 * Installs globals with `defineProperty` rather than assignment: Node defines
 * `navigator` as a getter with no setter, so `globalThis.navigator = x` throws
 * under the "use strict" that ts-jest emits.
 */
function withGlobals(values: Record<string, unknown>, body: () => void): void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, Object.getOwnPropertyDescriptor(GLOBALS, name));
    Object.defineProperty(GLOBALS, name, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  try {
    body();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete GLOBALS[name];
      else Object.defineProperty(GLOBALS, name, descriptor);
    }
  }
}

function expectRefused(key: string): ConfigurationError {
  let caught: unknown;
  try {
    assertDeviceSafeApiKey(key);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigurationError);
  const error = caught as ConfigurationError;
  expect(error.reason).toBe("secret_key_in_browser");
  return error;
}

describe("a secret key is refused on a device, unconditionally", () => {
  it("refuses tc_sk_live_", () => {
    expectRefused(SECRET);
  });

  it("refuses tc_sk_test_ as well — a test secret is still extractable", () => {
    expectRefused(SECRET_TEST);
  });

  it("accepts a publishable key, live and test", () => {
    expect(assertDeviceSafeApiKey(PUBLISHABLE)).toMatchObject({
      kind: "publishable",
      environment: "live",
    });
    expect(assertDeviceSafeApiKey(PUBLISHABLE_TEST)).toMatchObject({
      kind: "publishable",
      environment: "test",
    });
  });

  it("names the key in the message by prefix and last four only — never the key", () => {
    const error = expectRefused(SECRET);
    expect(error.message).toContain("tc_sk_live_…aaaa");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("a".repeat(48));
  });

  it("keeps the JavaScript SDK's reason spelling so cross-platform code branches once", () => {
    // SDK-W3 names one condition. A second spelling would mean a shared
    // codebase handling two strings for one mistake.
    expect(expectRefused(SECRET).reason).toBe("secret_key_in_browser");
  });

  it("offers no bypass: no option, no flag, no second argument", () => {
    expect(assertDeviceSafeApiKey).toHaveLength(1);
    const source = assertDeviceSafeApiKey.toString();
    for (const bypass of ["dangerously", "allowSecret", "force", "__DEV__", "override"]) {
      expect(source).not.toContain(bypass);
    }
  });
});

describe("BUG-022: the refusal reads no global, so no shim can move it", () => {
  /**
   * Every global `@trackcore/sdk`'s `detectRuntime()` consults, set to the
   * value that makes it answer "server". If the device refusal depended on any
   * of them — in any order — at least one of these would let a secret through.
   */
  const SERVER_SHIMS: Record<string, unknown> = {
    // The BUG-022 signal itself: a bundler-shimmed Node process.
    process: { versions: { node: "22.0.0" }, env: { TRACKCORE_RUNTIME: "server" } },
    Deno: { version: { deno: "2.0.0" } },
    Bun: { version: "1.1.0" },
    EdgeRuntime: "edge-runtime",
    navigator: { userAgent: "Cloudflare-Workers", product: "ReactNative" },
  };

  it("refuses a secret key with a shimmed process.versions.node present", () => {
    withGlobals({ process: SERVER_SHIMS["process"] }, () => {
      expectRefused(SECRET);
    });
  });

  it("refuses a secret key with the exact BUG-022 shape: shimmed process AND a worker global", () => {
    // This is the bug's reproduction, transplanted. Under the JavaScript SDK's
    // detector this returns { kind: "server" } and the key is accepted.
    withGlobals(
      {
        process: SERVER_SHIMS["process"],
        WorkerGlobalScope: function WorkerGlobalScope() {},
        importScripts: () => undefined,
      },
      () => {
        expectRefused(SECRET);
      },
    );
  });

  it("refuses a secret key with every server-announcing global set at once", () => {
    withGlobals(SERVER_SHIMS, () => {
      expectRefused(SECRET);
    });
  });

  it("refuses a secret key with TRACKCORE_RUNTIME=server forced in the environment", () => {
    withGlobals(
      { process: { versions: { node: "22.0.0" }, env: { TRACKCORE_RUNTIME: "server" } } },
      () => {
        expectRefused(SECRET);
      },
    );
  });

  it("refuses a secret key with no globals at all", () => {
    withGlobals({ process: undefined, navigator: undefined }, () => {
      expectRefused(SECRET);
    });
  });

  it("accepts a publishable key under the same shims — the guard keys on the key, not the host", () => {
    withGlobals(SERVER_SHIMS, () => {
      expect(assertDeviceSafeApiKey(PUBLISHABLE).kind).toBe("publishable");
    });
  });

  it("the compiled guard mentions none of the detector's globals", () => {
    // Static evidence to go with the behavioural evidence: whatever a future
    // edit does, it cannot start consulting these without failing here.
    const source = assertDeviceSafeApiKey.toString();
    for (const name of [
      "process",
      "navigator",
      "window",
      "document",
      "WorkerGlobalScope",
      "importScripts",
      "HermesInternal",
      "globalThis",
      "detectRuntime",
      "detectReactNativeRuntime",
    ]) {
      expect(source).not.toContain(name);
    }
  });
});

describe("malformed and missing credentials", () => {
  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
  ])("reports %s as api_key_missing", (_label, value) => {
    try {
      assertDeviceSafeApiKey(value);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).reason).toBe("api_key_missing");
    }
  });

  it.each([
    ["a Stripe-shaped key", "sk_live_abcdefghijklmnopqrstuvwxyz"],
    ["a truncated TrackCore key", "tc_pk_live_tooshort"],
    ["an unknown kind", `tc_xx_live_${"a".repeat(48)}`],
    ["an unknown environment", `tc_pk_prod_${"a".repeat(48)}`],
  ])("reports %s as api_key_malformed without echoing it", (_label, value) => {
    try {
      assertDeviceSafeApiKey(value);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).reason).toBe("api_key_malformed");
      expect((error as ConfigurationError).message).not.toContain(value as string);
    }
  });

  it("trims before parsing, so a pasted key with a trailing newline works", () => {
    expect(assertDeviceSafeApiKey(`  ${PUBLISHABLE}\n`).kind).toBe("publishable");
  });

  it("uses @trackcore/sdk's parser rather than a second regex", () => {
    // If this package ever grew its own token pattern, the two would drift the
    // first time KEY_ENTROPY_BYTES changed server-side.
    expect(parseApiKey(PUBLISHABLE)).toMatchObject({ kind: "publishable", last4: "cccc" });
  });
});
