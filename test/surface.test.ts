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

import * as js from "@trackcore/sdk";
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

  it("exports the identity symbols, so a sign-in form can validate without a client", () => {
    // D-012. These are `@trackcore/sdk`'s, re-exported — `identity.test.ts`
    // asserts the object identities. They are here so an app can check the id
    // it is about to pass at the boundary where it is typed or read, rather
    // than discovering the problem from a throw inside `setUser`.
    expect(typeof rn.assertValidExternalId).toBe("function");
    expect(rn.EXTERNAL_ID_HEADER).toBe("X-External-Id");
    expect(rn.EXTERNAL_ID_MAX_CODE_POINTS).toBe(255);
  });
});

describe("what the core does not export", () => {
  const names = Object.keys(rn);

  it("does not re-export the JavaScript SDK's browser-detecting client", () => {
    // The JavaScript `TrackCore` classifies React Native as runtime "unknown"
    // and therefore only *warns* about a secret key. Shipping it here would
    // ship a bypass. This package's `TrackCore` is the singleton holder,
    // which has no constructor and builds its client through the device
    // guard.
    expect(rn.TrackCore).not.toBe(js.TrackCore);
    expect(typeof rn.TrackCore.instance.configure).toBe("function");
    // Its client is built through the device guard, so a secret key is refused.
    expect(() => rn.TrackCore.instance.configure({ apiKey: `tc_sk_live_${"k".repeat(43)}`, baseUrl: "http://127.0.0.1:1" })).toThrow();
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

  it("exposes the profile, goals, health values and the calculator (0019)", () => {
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    expect(typeof client.profile.get).toBe("function");
    expect(typeof client.profile.set).toBe("function");
    expect(typeof client.diary.setGoal).toBe("function");
    expect(typeof client.diary.goal).toBe("function");
    expect(typeof client.healthData.log).toBe("function");
    expect(typeof client.healthData.records).toBe("function");
    expect(typeof client.healthData.daily).toBe("function");
    expect(typeof client.healthData.delete).toBe("function");
    expect(typeof client.nutrition.calculate).toBe("function");
    expect(typeof client.nutrition.plan).toBe("function");
    // The liveness probe keeps its name beside the health-values namespace.
    expect(typeof client.health).toBe("function");
  });

  it("scans several photos as one meal, each as its own request", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown, init: { body: FormData }) => {
      const image = init.body.get("image") as Blob;
      const n = new Uint8Array(await image.arrayBuffer())[3];
      seen.push(`${String(input).replace(/^.*\/v1/, "/v1")} photo ${n}`);
      const body =
        n === 1
          ? '{"error":{"code":"unsupported_image_format","message":"Only image/jpeg and image/png are accepted.","request_id":"req_1","docs_url":"https://docs.trackcore.dev/errors/unsupported_image_format","retry_after_seconds":null}}'
          : `{"status":"ok","result_kind":"food","items":[{"label":"food-${n}"}]}`;
      return {
        status: n === 1 ? 415 : 200,
        headers: new Headers({ "Content-Type": "application/json", "X-Request-Id": `req_${n}` }),
        text: async () => body,
      };
    }) as unknown as rn.FetchLike;
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1", fetch: fetchImpl });
    const photo = (n: number): rn.LabelImage => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, n]), contentType: "image/jpeg" });

    const meal: rn.PhotosRecognition = await client.image.foodPhotos([photo(0), photo(1), photo(2)], { concurrency: 1 });

    expect(seen).toEqual(["/v1/image/food photo 0", "/v1/image/food photo 1", "/v1/image/food photo 2"]);
    expect(meal.status).toBe("ok");
    expect(meal.failed).toBe(1);
    expect(meal.items).toEqual([{ label: "food-0" }, { label: "food-2" }]);
    expect(meal.photos.map((p: rn.PhotoScan) => p.status)).toEqual(["ok", "failed", "ok"]);
    expect(rn.isErrorOfCode(meal.photos[1]?.error, "unsupported_image_format")).toBe(true);

    const fridge = await client.image.fridgePhotos([photo(0)]);
    expect(seen.at(-1)).toBe("/v1/image/fridge photo 0");
    expect(fridge.items).toHaveLength(1);

    expect(rn.MAX_PHOTOS_PER_CALL).toBe(10);
    await expect(client.image.foodPhotos([])).rejects.toBeInstanceOf(TypeError);
  });

  it("exposes setUser, clearUser and a read-only externalId (D-012, SDK-C9)", () => {
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    expect(typeof client.setUser).toBe("function");
    expect(typeof client.clearUser).toBe("function");
    expect(client.externalId).toBeNull();

    // The names are fixed across all three SDKs, so a developer moving between
    // the Flutter app and the React Native one does not have to look them up.
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(client) as object,
      "externalId",
    );
    expect(typeof descriptor?.get).toBe("function");
    // Read-only: the only ways to change it are setUser and clearUser, both of
    // which go through the shared validator.
    expect(descriptor?.set).toBeUndefined();
  });

  it("does its nutrition arithmetic nowhere (SDK-C2, DM-N10)", () => {
    // This used to assert that `diary` and `log` were absent too, which was
    // right while the diary did not exist. It does now, and `diary.log` is a
    // server call: the entry, its snapshot and its scaled nutrition are all
    // computed by the gateway.
    //
    // What stays forbidden is the SDK doing the arithmetic itself. `scale`,
    // `sum` and `normalise` on the client are the exact shape of the code that
    // dropped 12 of 19 nutrients in the customer's own app, which is why
    // `POST /v1/foods/scale` is a route and not a method here.
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    const surface = [
      ...Object.keys(client),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object),
      ...Object.keys(client.foods),
      ...Object.keys(client.diary),
    ];
    for (const forbidden of ["scale", "sum", "normalise", "normalize"]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it("works out the quantity that logs an amount of a measurement", () => {
    // `Food.measurements` names one unit per entry. The diary takes a serving
    // and a quantity, so the amount typed is turned into that quantity here,
    // exactly. It is a quantity and not a nutrient: the rule above stands.
    const grams = { consumed_quantity_per_unit: new rn.Decimal("0.01") };
    const quantity = rn.consumedQuantityFor(grams, 150);
    // A Decimal, so it is sent as a bare number: the API refuses a string.
    expect(quantity).toBeInstanceOf(rn.Decimal);
    expect(quantity.toString()).toBe("1.5");
    expect(JSON.stringify({ consumed_quantity: quantity })).toBe('{"consumed_quantity":1.5}');
    expect(rn.consumedQuantityFor({ consumed_quantity_per_unit: new rn.Decimal("1") }, "2.5").toString()).toBe("2.5");
    expect(() => rn.consumedQuantityFor(grams, 0)).toThrow(RangeError);
  });

  it("has no auth or users namespace — both need a secret key, which a device never holds", () => {
    // `auth.createSession` mints device tokens; `users.delete` is the GDPR
    // erasure (PF-T5). Both live in `@trackcore/sdk` on the customer's server.
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    expect((client as unknown as Record<string, unknown>)["auth"]).toBeUndefined();
    expect((client as unknown as Record<string, unknown>)["users"]).toBeUndefined();
  });

  it("exposes the diary and session surface the device path needs (T-126)", () => {
    const client = rn.createTrackCoreClient({ apiKey, baseUrl: "http://127.0.0.1:1" });
    for (const method of ["day", "meals", "range", "log", "editPortion", "createMeal", "favourites", "recents"]) {
      expect(typeof (client.diary as Record<string, unknown>)[method]).toBe("function");
    }
    expect(typeof client.setSession).toBe("function");
    expect(typeof client.clearSession).toBe("function");
    expect(client.sessionToken).toBeNull();

    // Read-only, like externalId: the only ways to change it are setSession and
    // clearSession.
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(client) as object,
      "sessionToken",
    );
    expect(typeof descriptor?.get).toBe("function");
    expect(descriptor?.set).toBeUndefined();
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

describe("what the package re-exports from the JavaScript SDK", () => {
  it("names the error detail helpers and the catalogue", () => {
    // The docs import these from this package; 0.6.0 re-exported the classes
    // but not these names, so the import failed.
    const surface = require("../src/index") as Record<string, unknown>;
    for (const name of ["isErrorOfReason", "isErrorReason", "isErrorDomain", "errorReasonSpec"]) {
      expect(typeof surface[name]).toBe("function");
    }
    expect(Object.keys(surface["ERROR_REASONS"] as object)).toContain("meal_minute_taken");
    expect(surface["ALL_ERROR_DOMAINS"]).toContain("diary");
  });
});
