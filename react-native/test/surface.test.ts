/**
 * The public surface.
 *
 * SDK-R5: full TypeScript types, no `any`. D-004/D-015: a capability that is
 * not in this SDK must be absent from autocomplete, not present and throwing —
 * a developer should learn the gap from their editor, never at 2am.
 *
 * This package is the device SDK, so the gap runs the other way from the
 * JavaScript SDK's: camera, voice and health *will* exist here, but as separate
 * optional sub-packages (T-113, T-114, T-119) so that a customer who only
 * searches for food links no native code (SDK-R2). T-111 is the core, and the
 * core must not pre-announce them.
 */

import * as rn from "../src";

describe("what the core exports", () => {
  it("exports the client factory and class", () => {
    expect(typeof rn.createTrackCoreClient).toBe("function");
    expect(typeof rn.TrackCoreClient).toBe("function");
  });

  it("exports the three specialisations", () => {
    expect(typeof rn.assertDeviceSafeApiKey).toBe("function");
    expect(typeof rn.createReactNativeFetch).toBe("function");
    expect(typeof rn.AsyncStorageResponseCache).toBe("function");
  });
});

describe("what the core does not export", () => {
  const names = Object.keys(rn);

  it("does not re-export the JavaScript SDK's browser-detecting client", () => {
    // `TrackCore` classifies React Native as runtime "unknown" and therefore
    // only *warns* about a secret key. Shipping it here would ship a bypass.
    expect(names).not.toContain("TrackCore");
  });

  it("does not re-export the runtime detector or the Credential holder", () => {
    // `Credential.create` + `Transport` is a two-line route around the
    // unconditional refusal. See src/index.ts for the full reasoning.
    expect(names).not.toContain("detectRuntime");
    expect(names).not.toContain("checkCredential");
    expect(names).not.toContain("Credential");
  });

  it.each([
    "scale",
    "scalePortion",
    "normaliseServing",
    "sumNutrition",
    "logFood",
    "diary",
  ])("has no %s — scaling and summation are server-side (SDK-C2, DM-N10)", (name) => {
    expect(names).not.toContain(name);
  });

  it.each(["offline", "queue", "enqueue", "replay", "sync"])(
    "has no %s — there is no offline support (decided 2026-10-23)",
    (name) => {
      expect(names.map((n) => n.toLowerCase())).not.toContain(name);
    },
  );

  it.each(["scanBarcode", "startVoice", "readHealth", "Camera", "Microphone", "HealthKit"])(
    "does not pre-announce %s — those are T-113/T-114/T-119 sub-packages",
    (name) => {
      expect(names).not.toContain(name);
    },
  );

  it("exports no capability that throws 'not implemented'", () => {
    for (const [name, value] of Object.entries(rn)) {
      if (typeof value !== "function") continue;
      expect(value.toString()).not.toMatch(/not implemented|unimplemented|TODO:/i);
      expect(name).toBeTruthy();
    }
  });
});

describe("the client's shape", () => {
  const apiKey = `tc_pk_test_${"e".repeat(48)}`;

  it("exposes foods.search, foods.get, foods.batch, capabilities.list and health", () => {
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    expect(typeof client.foods.search).toBe("function");
    expect(typeof client.foods.get).toBe("function");
    expect(typeof client.foods.batch).toBe("function");
    expect(typeof client.capabilities.list).toBe("function");
    expect(typeof client.health).toBe("function");
  });

  it("exposes no scaling or diary method on the client", () => {
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    const surface = [
      ...Object.keys(client),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object),
      ...Object.keys(client.foods),
    ];
    for (const forbidden of ["scale", "log", "diary", "sum", "normalise", "normalize"]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it("reports the credential by prefix and last four, never the key", () => {
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    expect(client.describeCredential()).toBe("tc_pk_test_…eeee");
    expect(client.environment).toBe("test");
    expect(client.keyKind).toBe("publishable");
  });

  it("does not leak the key through JSON.stringify of the client", () => {
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    const serialised = JSON.stringify(client);
    expect(serialised).not.toContain("e".repeat(48));
    expect(serialised).toContain("tc_pk_test_");
  });

  it("refuses a secret key from the client constructor, before any network setup", () => {
    expect(() =>
      rn.createTrackCoreClient({
        apiKey: `tc_sk_live_${"f".repeat(48)}`,
        // An invalid base URL as well: if the credential check did not run
        // first, this would be the error that surfaced.
        baseUrl: "not-a-url",
      }),
    ).toThrow(
      expect.objectContaining({ reason: "secret_key_in_browser" }) as unknown as Error,
    );
  });
});
