/**
 * End-user identification on a device: `setUser`, `clearUser`, and the header
 * they govern.
 *
 * This package implements none of the rules below. `setUser` hands straight to
 * `@trackcore/sdk`'s `TrackCore`, which validates and stores the string, and
 * the header is written in the shared `Transport` — one line, in one place, on
 * every attempt. So what is worth testing here is not the validation logic a
 * second time; it is that the pass-through is real and that nothing in the
 * React Native layer breaks it on the way out.
 *
 * Four things could, and each has a block below:
 *
 *   `createReactNativeFetch` rebuilds the header object on every request —
 *   defaulting `Cache-Control`, stamping `X-TrackCore-Client` — so a spread
 *   written in the wrong order there would drop `X-External-Id` silently and
 *   nothing else in the suite would notice.
 *
 *   The body-carrying `POST`s build their headers down a different branch of
 *   `Transport.#attempt` from the `GET`s, and for the multipart ones the
 *   `Content-Type` is not in the header object at all — `fetch` derives it
 *   from the `FormData`, boundary included. A mutant that dropped the header
 *   on exactly those requests kept this whole suite green (BUG-024), which in
 *   production is Food Scan AI, FridgeAI, Label AI and Voice→text reaching the
 *   gateway with nobody attached. So the POSTs get their own block, and it
 *   asserts the identity header and the derived `Content-Type` together.
 *
 *   Absent and blank are indistinguishable to the gateway, and the assertions
 *   below keep the header absent anyway. `provisionUser`
 *   (`services/gateway/internal/httpx/guard.go`) reads it with Go's
 *   `Header.Get`, which answers `""` for a header that is missing and for one
 *   that is present and empty alike — `net/textproto` having already stripped
 *   the surrounding whitespace — and takes the early return on both. **Neither
 *   is a `400`**: this file used to say it was, and that was wrong (BUG-028).
 *   The reason that does hold is that omitting the header gives a signed-out
 *   request exactly one shape on the wire, which is unambiguous now and stays
 *   correct if the blank case is ever tightened. Hence `Object.keys` rather
 *   than `toBeUndefined()`, which passes for a key that is *present* with the
 *   value `undefined` — something `fetch` serialises as the four characters
 *   "undefined".
 *
 *   The identity symbols are re-exported rather than redeclared. The last two
 *   blocks assert that by reference and against the shared cross-SDK fixture,
 *   because a comment promising it is not evidence — a hand-written copy of
 *   `assertValidExternalId` here would pass every behavioural test in this
 *   file on the day it was written and drift the first time the rule changed
 *   in one SDK and not the others.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as rn from "../src";
import * as js from "@trackcore/sdk";
import {
  AsyncStorageResponseCache,
  ConfigurationError,
  EXTERNAL_ID_HEADER,
  EXTERNAL_ID_MAX_CODE_POINTS,
  assertValidExternalId,
  createTrackCoreClient,
  type AsyncStorageLike,
  type ConfigurationErrorReason,
  type FetchLike,
  type TrackCoreClient,
} from "../src";

/** Publishable, because a device client refuses anything else. */
const API_KEY = `tc_pk_test_${"e".repeat(48)}`;
const BASE_URL = "https://api.trackcore.test";
const APPLE_ID = "tc_food_0H0MSKADSH7000000000000000";

/** A food body thin enough to read, shaped enough to decode. */
const FOOD = '{"food_id":"tc_food_0H0MSKADSH7000000000000000","metric_amount":138.000}';

/**
 * The shared end-user identity contract (D-012), read from `sdks/`.
 *
 * One file, three SDKs. `services/gateway/internal/httpx/guard.go`'s
 * `validExternalID` is the source of truth for the first three values; the
 * fixture's own comment records that binding it to the Go side is still a
 * follow-up. What this suite can do is refuse to drift from it.
 */
interface IdentityContract {
  readonly headerName: string;
  readonly maxCodePoints: number;
  readonly minCodePoint: number;
  readonly maxCodePointValue: number;
  readonly reasons: {
    readonly untrimmed: string;
    readonly empty: string;
    readonly tooLong: string;
    readonly notAscii: string;
  };
  readonly javascriptOnlyReasons: { readonly notAString: string };
}

const CONTRACT = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "identity-contract.json"), "utf8"),
) as IdentityContract;

/** The `reason` `assertValidExternalId` refused `value` with. Throws if it did not. */
function reasonFor(value: unknown): string {
  try {
    assertValidExternalId(value as string);
  } catch (error) {
    return (error as ConfigurationError).reason;
  }
  throw new Error(`assertValidExternalId accepted an id the contract says it must refuse`);
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  /**
   * `Content-Type` as `fetch` itself would put it on the wire.
   *
   * Reading `headers["Content-Type"]` is not enough for the multipart POSTs:
   * the SDK never writes one, because only the `FormData` knows the boundary,
   * so the platform derives the whole value from the body. Handing the exact
   * `RequestInit` the adapter produced to `new Request` is how this suite asks
   * the platform what it would have sent, rather than guessing.
   */
  readonly contentType: string | null;
}

interface Harness {
  readonly client: TrackCoreClient;
  /** Every request the injected `fetch` was actually asked to make, in order. */
  readonly calls: Call[];
}

/** What the platform makes of the `RequestInit` the adapter handed `fetch`. */
function record(url: string, init: RequestInit): Call {
  return {
    method: init.method ?? "GET",
    url,
    headers: init.headers as Record<string, string>,
    contentType: new Request(url, init).headers.get("content-type"),
  };
}

/** A client over a `fetch` that answers everything with `body` and records it. */
function harness(body = "{}"): Harness {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(record(url, init));
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_test" },
    });
  };
  return { client: createTrackCoreClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchImpl }), calls };
}

/** In-process `AsyncStorage`, as `cache.test.ts` fakes it. */
class FakeAsyncStorage implements AsyncStorageLike {
  readonly items = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.items.delete(key);
  }

  async getAllKeys(): Promise<readonly string[]> {
    return [...this.items.keys()];
  }

  async multiRemove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.items.delete(key);
  }
}

describe("the header, as the injected fetch actually received it", () => {
  it("is absent before setUser — absent, not blank", async () => {
    const { client, calls } = harness(FOOD);
    await client.foods.get(APPLE_ID);

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.headers)).not.toContain(EXTERNAL_ID_HEADER);
    expect(client.externalId).toBeNull();
  });

  it("carries the exact value after setUser", async () => {
    const { client, calls } = harness(FOOD);
    client.setUser("firebase_9xKq2LmN4pR7");
    await client.foods.get(APPLE_ID);

    expect(calls[0]!.headers[EXTERNAL_ID_HEADER]).toBe("firebase_9xKq2LmN4pR7");
    expect(client.externalId).toBe("firebase_9xKq2LmN4pR7");
  });

  it("is absent again after clearUser", async () => {
    const { client, calls } = harness(FOOD);
    client.setUser("user_42");
    await client.foods.get(APPLE_ID);
    client.clearUser();
    await client.foods.get(APPLE_ID);

    expect(calls[0]!.headers[EXTERNAL_ID_HEADER]).toBe("user_42");
    expect(Object.keys(calls[1]!.headers)).not.toContain(EXTERNAL_ID_HEADER);
    expect(client.externalId).toBeNull();
  });

  it("survives the React Native adapter's own header rebuild", async () => {
    // `createReactNativeFetch` spreads the caller's headers into a fresh
    // object between `Cache-Control` and `X-TrackCore-Client`. All three must
    // come out the far end together, or the regression is a dropped identity
    // that only shows up as missing attribution weeks later.
    const { client, calls } = harness(FOOD);
    client.setUser("user_adapter");
    await client.foods.get(APPLE_ID);

    const headers = calls[0]!.headers;
    expect(headers[EXTERNAL_ID_HEADER]).toBe("user_adapter");
    expect(headers["X-TrackCore-Client"]).toMatch(/^trackcore-react-native\//);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("follows the client, not the call: every subsequent request carries it", async () => {
    const { client, calls } = harness(FOOD);
    client.setUser("user_a");
    await client.foods.get(APPLE_ID);
    await client.foods.search({ q: "apple" });
    await client.barcode.lookup("0123456789012");
    client.setUser("user_b");
    await client.foods.get(APPLE_ID);

    expect(calls.map((call) => call.headers[EXTERNAL_ID_HEADER])).toEqual([
      "user_a",
      "user_a",
      "user_a",
      "user_b",
    ]);
  });

  it("rides on the health probe too, not only the food resources", async () => {
    const { client, calls } = harness('{"status":"ok","version":"0.1.0"}');
    client.setUser("user_probe");
    await client.health();

    expect(calls[0]!.url).toBe(`${BASE_URL}/healthz`);
    expect(calls[0]!.headers[EXTERNAL_ID_HEADER]).toBe("user_probe");
  });

  it("rides on an ETag revalidation (SDK-O4) — a 304 is still an attributable request", async () => {
    const calls: Call[] = [];
    let served = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(record(url, init));
      const first = served++ === 0;
      return first
        ? new Response(FOOD, {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: 'W/"tag"' },
          })
        : // 304 is a null-body status; `new Response("", …)` throws.
          new Response(null, { status: 304, headers: { ETag: 'W/"tag"' } });
    };

    const cache = new AsyncStorageResponseCache({ storage: new FakeAsyncStorage() });
    const client = createTrackCoreClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      cache,
    });
    client.setUser("user_etag");
    await client.foods.get(APPLE_ID, { revalidate: true });
    await client.foods.get(APPLE_ID, { revalidate: true });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["If-None-Match"]).toBe('W/"tag"');
    expect(calls[1]!.headers[EXTERNAL_ID_HEADER]).toBe("user_etag");
  });

  it("is never sent empty, on any request, in any state", async () => {
    const { client, calls } = harness(FOOD);
    await client.foods.get(APPLE_ID);
    client.setUser("user_1");
    await client.foods.get(APPLE_ID);
    client.clearUser();
    await client.foods.get(APPLE_ID);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(Object.values(call.headers)).not.toContain("");
    }
  });
});

describe("the body-carrying POSTs carry it too — label, image and NLP", () => {
  /*
   * BUG-024. Every assertion in the block above drives a `GET`. `Transport`
   * writes `X-External-Id` once, before it branches on the body, so this was
   * always working — but nothing proved it, and the mutant that breaks it
   * (write the header only when `body` and `rawBody` are both undefined) left
   * all 158 tests here and all 250 in the JavaScript SDK green. These four
   * endpoints are Label AI, Food Scan AI, FridgeAI and Voice→text; losing the
   * header on exactly them is unattributed usage that fails silently for
   * weeks. Modelled on Flutter's `test/external_id_test.dart:72`.
   *
   * The `Content-Type` assertions are the second half of the point. The RN
   * adapter rebuilds the header object per request, and a rebuild that
   * invented a `Content-Type` would destroy a multipart boundary just as
   * quietly as one that dropped the identity header.
   */

  /** Four bytes of "JPEG": SOI then EOI. Enough to be a photo; not a fixture. */
  const PHOTO = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg" } as const;
  const RECORDING = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), contentType: "audio/wav" } as const;

  const LABEL_OK = '{"status":"ok","is_product_label":true,"food":null}';
  const RECOGNITION_OK = '{"status":"ok","result_kind":"food","items":[]}';
  const NLP_OK = '{"text":"two eggs","results":[]}';

  it("rides a multipart POST, alongside the boundary Content-Type fetch derives", async () => {
    const { client, calls } = harness(LABEL_OK);
    client.setUser("user_label");
    await client.label.extract(PHOTO);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE_URL}/v1/label`);
    expect(call.headers[EXTERNAL_ID_HEADER]).toBe("user_label");
    // Nothing in this SDK may write a multipart Content-Type: only the
    // FormData knows the boundary. The absence is the assertion.
    expect(Object.keys(call.headers)).not.toContain("Content-Type");
    expect(call.contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("rides a JSON POST, alongside its application/json Content-Type", async () => {
    const { client, calls } = harness(NLP_OK);
    client.setUser("user_nlp");
    await client.nlp.search("two eggs");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE_URL}/v1/nlp`);
    expect(call.headers[EXTERNAL_ID_HEADER]).toBe("user_nlp");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.contentType).toBe("application/json");
  });

  it("pins all four headers together on a POST, as the GET case does", async () => {
    // `createReactNativeFetch` spreads the caller's headers between
    // `Cache-Control` and `X-TrackCore-Client` on every request, body or no
    // body. "survives the React Native adapter's own header rebuild" above is
    // this assertion for a GET; a POST goes down the other branch of
    // `Transport.#attempt`, so it needs its own.
    const { client, calls } = harness(LABEL_OK);
    client.setUser("user_adapter_post");
    await client.label.extract(PHOTO);

    const headers = calls[0]!.headers;
    expect(headers[EXTERNAL_ID_HEADER]).toBe("user_adapter_post");
    expect(headers["X-TrackCore-Client"]).toMatch(/^trackcore-react-native\//);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("rides every POST endpoint this SDK has, not just the one under test", async () => {
    const bodies = [LABEL_OK, RECOGNITION_OK, RECOGNITION_OK, NLP_OK, NLP_OK];
    const calls: Call[] = [];
    let served = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(record(url, init));
      return new Response(bodies[served++], {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Request-Id": "req_test" },
      });
    };
    const client = createTrackCoreClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchImpl });

    client.setUser("user_everywhere");
    await client.label.extract(PHOTO);
    await client.image.food(PHOTO);
    await client.image.fridge(PHOTO);
    await client.nlp.search("two eggs");
    await client.nlp.fromSpeech(RECORDING);

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/v1/label`,
      `${BASE_URL}/v1/image/food`,
      `${BASE_URL}/v1/image/fridge`,
      `${BASE_URL}/v1/nlp`,
      `${BASE_URL}/v1/nlp`,
    ]);
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.headers[EXTERNAL_ID_HEADER]).toBe("user_everywhere");
    }
    // Four multipart, one JSON — and the JSON one is `nlp.search`, which is
    // the only POST whose Content-Type the SDK writes itself.
    expect(calls.map((call) => call.contentType?.split(";")[0])).toEqual([
      "multipart/form-data",
      "multipart/form-data",
      "multipart/form-data",
      "application/json",
      "multipart/form-data",
    ]);
  });

  it("stops carrying it on a POST after clearUser, without going blank", async () => {
    const { client, calls } = harness(LABEL_OK);
    client.setUser("user_signed_in");
    await client.label.extract(PHOTO);
    client.clearUser();
    await client.label.extract(PHOTO);

    expect(calls[0]!.headers[EXTERNAL_ID_HEADER]).toBe("user_signed_in");
    expect(Object.keys(calls[1]!.headers)).not.toContain(EXTERNAL_ID_HEADER);
    // Still a well-formed multipart request with nobody attached, which is
    // what a signed-out scan is supposed to be.
    expect(calls[1]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
  });
});

describe("validation happens at the call site, before any socket", () => {
  /** Asserts `setUser(value)` threw the named reason and sent nothing. */
  async function refuses(value: unknown, reason: ConfigurationErrorReason): Promise<void> {
    const { client, calls } = harness(FOOD);
    let thrown: unknown;
    try {
      client.setUser(value as string);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).reason).toBe(reason);
    // The point of validating synchronously: nothing left the device. A
    // malformed id that reaches the gateway is a 400, but a *valid-looking*
    // corrupted one is a second app_user row, which nothing fails on.
    expect(calls).toHaveLength(0);
    // And a refused id does not half-apply.
    expect(client.externalId).toBeNull();
  }

  it("refuses leading or trailing whitespace rather than trimming it", async () => {
    await refuses(" user_1", "external_id_untrimmed");
    await refuses("user_1 ", "external_id_untrimmed");
    await refuses("user_1\n", "external_id_untrimmed");
    await refuses("   ", "external_id_untrimmed");
  });

  it("refuses the empty string", async () => {
    await refuses("", "external_id_empty");
  });

  it("refuses anything that is not a string", async () => {
    await refuses(undefined, "external_id_not_a_string");
    await refuses(42, "external_id_not_a_string");
    await refuses({ uid: "user_1" }, "external_id_not_a_string");
  });

  it("refuses null rather than treating it as a sign-out", async () => {
    // TypeScript rules this out; a JavaScript React Native app wiring
    // `onAuthStateChanged` straight through does not. If `setUser(null)` meant
    // "clear", a null user object would quietly unattribute every later call
    // instead of failing where the mistake is.
    await refuses(null, "external_id_not_a_string");

    const { client } = harness(FOOD);
    client.setUser("user_1");
    expect(() => client.setUser(null as unknown as string)).toThrow(ConfigurationError);
    expect(client.externalId).toBe("user_1");
  });

  it("accepts 255 code points and refuses 256", async () => {
    const { client } = harness(FOOD);
    client.setUser("a".repeat(EXTERNAL_ID_MAX_CODE_POINTS));
    expect(client.externalId).toHaveLength(255);
    await refuses("a".repeat(EXTERNAL_ID_MAX_CODE_POINTS + 1), "external_id_too_long");
  });

  it("measures that limit in code points, the way Go counts runes", async () => {
    // 255 astral-plane code points is 510 UTF-16 units. A `.length` check
    // would call this too long; the shared implementation gets past the length
    // rule and refuses it for not being ASCII, which is the only observable
    // difference between the two.
    const astral = "😀".repeat(EXTERNAL_ID_MAX_CODE_POINTS);
    expect(astral.length).toBe(510);
    await refuses(astral, "external_id_not_ascii");
    await refuses("😀".repeat(EXTERNAL_ID_MAX_CODE_POINTS + 1), "external_id_too_long");
  });

  it("refuses non-ASCII an HTTP header would silently corrupt", async () => {
    await refuses("user_café", "external_id_not_ascii");
    await refuses("ユーザー_1", "external_id_not_ascii");
    await refuses("user\u0000", "external_id_not_ascii");
    await refuses("user\r\nX-Injected: 1", "external_id_not_ascii");
  });

  it("accepts the id shapes a mobile app actually has", () => {
    const { client } = harness(FOOD);
    for (const id of [
      "9xKq2LmN4pR7sT1vW3yZ5bD8gH0j", // Firebase UID
      "018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b", // UUID
      "01HQ8ZJX5K9M2N4P6R8T0V2W4Y", // ULID
      "1",
      "ada@example.com",
    ]) {
      expect(() => client.setUser(id)).not.toThrow();
      expect(client.externalId).toBe(id);
    }
  });

  it("names the offending code point without repeating the id", () => {
    // An external_id is usually the customer's own user identifier and often
    // an email. A rejection message travels into Metro's console, Sentry and
    // whatever crash reporter the app ships.
    let message = "";
    try {
      assertValidExternalId("ada.lovelace@example.comé");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("ada.lovelace");
    expect(message).toContain("U+00E9");
  });
});

describe("the ETag cache is kept across a user switch, on purpose", () => {
  it("still serves a 304 from the stored body after signing a different user in", async () => {
    // Everything stored is catalogue data — a food's nutrition is the same for
    // every end user, and nothing user-scoped is written to AsyncStorage at
    // all. Clearing on sign-in would throw away a warm device cache and make
    // the next screen pay for a full body over a metered connection. The
    // Flutter SDK made the same call; if it ever stops being true, all three
    // change together.
    const storage = new FakeAsyncStorage();
    const cache = new AsyncStorageResponseCache({ storage });
    let served = 0;
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      seen.push(headers[EXTERNAL_ID_HEADER] ?? "<absent>");
      return served++ === 0
        ? new Response(FOOD, {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: 'W/"tag"' },
          })
        : new Response(null, { status: 304, headers: { ETag: 'W/"tag"' } });
    };

    const client = createTrackCoreClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      cache,
    });

    client.setUser("user_first");
    const first = await client.foods.get(APPLE_ID, { revalidate: true });

    client.setUser("user_second");
    expect(cache.get(`GET ${BASE_URL}/v1/foods/${APPLE_ID}`)?.etag).toBe('W/"tag"');

    const second = await client.foods.get(APPLE_ID, { revalidate: true });

    // The second read was a conditional one answered 304 from the store, and
    // the body is the same catalogue body, attributed to the new user.
    expect(seen).toEqual(["user_first", "user_second"]);
    expect(second.food_id).toBe(first.food_id);
    await cache.flush();
    expect(storage.items.size).toBe(1);
  });
});

describe("the identity surface is the JavaScript SDK's, not a copy of it", () => {
  it("re-exports the same validator function object", () => {
    // `toBe` on a function is reference equality. A vendored copy, a wrapper,
    // or a second module instance pulled in through a different resolution
    // path all fail this.
    expect(rn.assertValidExternalId).toBe(js.assertValidExternalId);
  });

  it("re-exports the header name and the limit, with the same values", () => {
    expect(rn.EXTERNAL_ID_HEADER).toBe(js.EXTERNAL_ID_HEADER);
    expect(rn.EXTERNAL_ID_MAX_CODE_POINTS).toBe(js.EXTERNAL_ID_MAX_CODE_POINTS);
    // Pinned as well as compared, because two copies of a constant agree right
    // up to the day one of them is edited.
    expect(rn.EXTERNAL_ID_HEADER).toBe("X-External-Id");
    expect(rn.EXTERNAL_ID_MAX_CODE_POINTS).toBe(255);
  });

  it("throws the JavaScript SDK's ConfigurationError, with its message", () => {
    const { client } = harness(FOOD);
    let fromClient: unknown;
    try {
      client.setUser(" padded");
    } catch (error) {
      fromClient = error;
    }
    let fromSdk: unknown;
    try {
      js.assertValidExternalId(" padded");
    } catch (error) {
      fromSdk = error;
    }

    expect(fromClient).toBeInstanceOf(js.ConfigurationError);
    // Identical prose means one message catalogue, not two that happen to
    // agree. A second implementation would have to copy the paragraph.
    expect((fromClient as Error).message).toBe((fromSdk as Error).message);
    expect((fromClient as ConfigurationError).reason).toBe(
      (fromSdk as ConfigurationError).reason,
    );
  });

  it("agrees with the cross-SDK contract fixture, not only with itself", () => {
    // `sdks/identity-contract.json` is the one checked-in statement of the
    // header name, the limit, the code-point bounds and the reason slugs.
    // Until it existed, parity between the JavaScript, Flutter and React
    // Native suites rested on three teams independently typing the same
    // literals, and nothing failed when one of them changed (BUG-029). The
    // literal assertions above are deliberately kept: this is an extra
    // binding, so a wrong edit has to be made in two places to pass.
    //
    // Reading it from outside the package is the point — a copy inside
    // `test/` would be a fourth place for the values to drift.
    expect(rn.EXTERNAL_ID_HEADER).toBe(CONTRACT.headerName);
    expect(rn.EXTERNAL_ID_MAX_CODE_POINTS).toBe(CONTRACT.maxCodePoints);
  });

  it("throws the fixture's four shared reason slugs, each from the rule it names", () => {
    expect(reasonFor(" user_1")).toBe(CONTRACT.reasons.untrimmed);
    expect(reasonFor("")).toBe(CONTRACT.reasons.empty);
    expect(reasonFor("a".repeat(CONTRACT.maxCodePoints + 1))).toBe(CONTRACT.reasons.tooLong);
    expect(reasonFor("user_café")).toBe(CONTRACT.reasons.notAscii);
  });

  it("throws the fixture's JavaScript-only fifth slug, which Dart cannot reach", () => {
    // `setUser(String)` rules this out at compile time in Flutter, so its
    // absence there is parity rather than an omission — the fixture says so,
    // and this is the half of that claim this SDK can prove.
    expect(reasonFor(42)).toBe(CONTRACT.javascriptOnlyReasons.notAString);
  });

  it("enforces the fixture's code-point bounds at both edges", () => {
    const { minCodePoint, maxCodePointValue } = CONTRACT;
    const inside = (code: number): string => `a${String.fromCodePoint(code)}a`;
    // Mid-string, because U+0020 at either end is a trimming violation first
    // and would prove the wrong rule.
    expect(() => assertValidExternalId(inside(minCodePoint))).not.toThrow();
    expect(() => assertValidExternalId(inside(maxCodePointValue))).not.toThrow();
    expect(reasonFor(inside(minCodePoint - 1))).toBe(CONTRACT.reasons.notAscii);
    expect(reasonFor(inside(maxCodePointValue + 1))).toBe(CONTRACT.reasons.notAscii);
  });

  it("writes none of the rules into this package's own source", () => {
    // The behavioural tests above would all pass against a hand-written
    // reimplementation on the day it was written. This is the one that would
    // not. Comments are stripped first, so the prose explaining the header may
    // name it; code may not.
    const strip = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src = join(__dirname, "..", "src");
    for (const name of ["client.ts", "index.ts"]) {
      const text = strip(readFileSync(join(src, name), "utf8"));
      expect(text).not.toContain("X-External-Id");
      expect(text).not.toMatch(/\bexternal_id_(untrimmed|empty|too_long|not_ascii)\b/);
      expect(text).not.toMatch(/\bcodePointAt\b|\b0x7e\b/i);
      expect(text).not.toContain("255");
    }
  });
});
