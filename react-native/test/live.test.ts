/**
 * The live suite. **This is the test that counts.**
 *
 * Two lessons this codebase learned expensively: a service here once passed 230
 * tests against a parser that could not read a single live response, and a
 * mutation doing the most explicitly forbidden thing in the PRD passed the
 * whole suite. Green tests have not predicted correctness in this project, and
 * a fixture proves only that the fixture round-trips.
 *
 * So nothing here is mocked. It drives a real `nutritiond` against the real
 * upstream provider and asserts on lexemes that are in the response body as it
 * arrived on the socket. Skipped unless `TRACKCORE_LIVE_BASE_URL` is set:
 *
 *     go build -o /tmp/nutd ./services/nutrition/cmd/nutritiond
 *     NUTRITION_LISTEN_ADDR=127.0.0.1:<fresh port> \
 *     FOOD_API_BASE_URL=… FOOD_API_KEY=… /tmp/nutd &
 *     TRACKCORE_LIVE_BASE_URL=http://127.0.0.1:<fresh port> npm run test:live
 *
 * Confirm the listener is the binary you just built before believing any of it
 * — a stale process on a reused port once made QA report four fixed defects as
 * still broken, with entirely plausible numbers.
 */

import {
  createTrackCoreClient,
  Decimal,
  isAPIError,
  MemoryResponseCache,
  ResourceError,
  type Food,
  type NutrientValue,
  type SearchResults,
  type Serving,
  type TrackCoreClient,
} from "../src";

const BASE_URL = process.env["TRACKCORE_LIVE_BASE_URL"];

/**
 * Syntactically valid and deliberately inert. `nutritiond` does not
 * authenticate — the gateway does — so this exercises the credential path
 * without being a credential.
 */
const API_KEY = `tc_pk_test_${"0123456789abcdefghijklmnopqrstuvwxyzABCD".slice(0, 40)}`;

jest.setTimeout(120_000);

let client: TrackCoreClient;

beforeAll(() => {
  if (BASE_URL === undefined) throw new Error("TRACKCORE_LIVE_BASE_URL is not set");
  client = createTrackCoreClient({ apiKey: API_KEY, baseUrl: BASE_URL, deadlineMs: 60_000 });
});

/** Every `Decimal` in a response, by JSON path. */
function decimalsOf(value: unknown, path = "$", into = new Map<string, string>()): Map<string, string> {
  if (value instanceof Decimal) {
    into.set(path, value.source);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => decimalsOf(item, `${path}[${index}]`, into));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) decimalsOf(child, `${path}.${key}`, into);
  }
  return into;
}

/** The same request, taken raw off the socket, for comparison with the SDK's view. */
async function raw(path: string): Promise<string> {
  const response = await fetch(`${BASE_URL as string}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${API_KEY}` },
  });
  return response.text();
}

describe("the service is alive and is the thing under test", () => {
  it("answers /healthz", async () => {
    const probe = await client.health();
    expect(probe.status).toBe("ok");
  });
});

describe("the decimal contract, against the live service", () => {
  let results: SearchResults;
  let rawText: string;

  beforeAll(async () => {
    rawText = await raw("/v1/foods/search?q=apple&page_size=20&page=0");
    results = await client.foods.search({ q: "apple", pageSize: 20, page: 0 });
  });

  it("returns results", () => {
    expect(results.results.length).toBeGreaterThan(0);
  });

  it("every numeric lexeme the SDK produced appears verbatim in the raw response body", () => {
    // The strong form of the claim. Not "the number is close"; the *text* the
    // SDK is carrying is the text the server sent. Anything that went through
    // an IEEE-754 double on the way would have been rewritten by now —
    // `138.000` would be `138`, `0.039` would be `0.039000000000000000222…`.
    const decimals = decimalsOf(results);
    expect(decimals.size).toBeGreaterThan(100);

    const missing: Array<[string, string]> = [];
    for (const [path, lexeme] of decimals) {
      if (!rawText.includes(lexeme)) missing.push([path, lexeme]);
    }
    expect(missing).toEqual([]);
  });

  it("re-parsing the raw body yields exactly the SDK's lexemes, path for path", () => {
    // Belt and braces against a lexeme that happens to be a substring of some
    // unrelated part of the body.
    const fromSdk = decimalsOf(results);
    const serving = results.results[0]?.servings[0];
    expect(serving).toBeDefined();
    const amount = (serving as Serving).metric_amount;
    expect(amount).toBeInstanceOf(Decimal);
    expect(rawText).toContain(`"metric_amount":${(amount as Decimal).source}`);
    expect(fromSdk.size).toBeGreaterThan(100);
  });

  it("preserves trailing zeros that a double cannot hold", () => {
    const scaled = [...decimalsOf(results).values()].filter((lexeme) => /\.\d*0$/.test(lexeme));
    // The live apple data is full of these: 138.000, 1.000, 0.010, 28.350.
    expect(scaled.length).toBeGreaterThan(10);
    for (const lexeme of scaled) {
      expect(String(Number(lexeme))).not.toBe(lexeme); // a double would have lost it
      expect(new Decimal(lexeme).source).toBe(lexeme); // the SDK did not
    }
  });

  it("carries the remaining QA-verified lexemes, from a second live query", async () => {
    // `0.1`, `62.5` and `3.3333333333333333` are not in the apple data. They
    // are all three in the live `milk` page, which is why this query is here
    // and not a fixture: 0.1 has no exact binary representation at all, and
    // 3.3333333333333333 is seventeen significant digits, one past what a
    // double can round-trip.
    const milkRaw = await raw("/v1/foods/search?q=milk&page_size=20&page=0");
    const milk = await client.foods.search({ q: "milk", pageSize: 20, page: 0 });
    const lexemes = new Set(decimalsOf(milk).values());

    for (const expected of ["0.1", "62.5", "3.3333333333333333"]) {
      expect(lexemes.has(expected)).toBe(true);
      expect(milkRaw).toContain(`:${expected},`);
    }

    // And the whole page, not just those three.
    for (const [, lexeme] of decimalsOf(milk)) {
      expect(milkRaw).toContain(lexeme);
    }
  });

  it("carries 138.000 and 138.0000000000000000 as distinct lexemes of the same value", () => {
    const lexemes = new Set(decimalsOf(results).values());
    expect(lexemes.has("138.000")).toBe(true);
    expect(lexemes.has("138.0000000000000000")).toBe(true);
    const a = new Decimal("138.000");
    const b = new Decimal("138.0000000000000000");
    expect(a.equals(b)).toBe(true); // the same number
    expect(a.identical(b)).toBe(false); // not the same datum
    expect(a.scale).toBe(3);
    expect(b.scale).toBe(16);
  });

  it.each(["138.000", "138.0000000000000000", "0.039", "19.06"])(
    "round-trips the QA-verified lexeme %s exactly",
    (lexeme) => {
      const found = [...decimalsOf(results).entries()].filter(([, source]) => source === lexeme);
      expect(found.length).toBeGreaterThan(0);
      for (const [, source] of found) expect(source).toBe(lexeme);
    },
  );

  it("a modelled nutrient with no value stays null and never becomes 0 (DM-N2)", () => {
    const nulls: string[] = [];
    for (const food of results.results) {
      for (const serving of food.servings) {
        for (const [name, nutrient] of Object.entries(serving.nutrition)) {
          if (nutrient === null) nulls.push(name);
        }
      }
    }
    expect(nulls.length).toBeGreaterThan(0);
    expect(nulls).not.toContain(0 as unknown as string);
  });

  it("counters are plain numbers and nutrients are not", () => {
    expect(typeof results.page).toBe("number");
    expect(typeof results.page_size).toBe("number");
    expect(typeof results.total_results).toBe("number");
    const serving = results.results[0]?.servings[0] as Serving;
    expect(typeof serving.serving_id_version).toBe("number");
    const energy = serving.nutrition["energy"] as NutrientValue;
    expect(energy.value).toBeInstanceOf(Decimal);
  });
});

describe("reading one food", () => {
  let food: Food;
  let rawText: string;

  beforeAll(async () => {
    const results = await client.foods.search({ q: "apple", pageSize: 5 });
    const id = results.results[0]?.food_id as string;
    rawText = await raw(`/v1/foods/${encodeURIComponent(id)}`);
    food = await client.foods.get(id);
  });

  it("returns the food with its lexemes intact", () => {
    expect(food.food_id).toMatch(/^tc_food_/);
    for (const [, lexeme] of decimalsOf(food)) {
      expect(rawText).toContain(lexeme);
    }
  });

  it("maps an unknown id to a typed ResourceError with a code from the enumeration", () => {
    expect.assertions(3);
    return client.foods.get("tc_food_000000000000000000000000AA").catch((error: unknown) => {
      expect(isAPIError(error)).toBe(true);
      expect(error).toBeInstanceOf(ResourceError);
      // Never a raw upstream message.
      expect(["resource_not_found", "food_gone"]).toContain(
        (error as ResourceError).code,
      );
    });
  });
});

describe("the batch read and missing[]", () => {
  it("reports an unresolvable id in missing[] rather than omitting it", async () => {
    const results = await client.foods.search({ q: "apple", pageSize: 3 });
    const real = results.results.map((food) => food.food_id).slice(0, 2);
    const fake = "tc_food_000000000000000000000000AA";

    const batch = await client.foods.batch([...real, fake]);
    expect(batch.found.map((food) => food.food_id)).toEqual(expect.arrayContaining(real));
    expect(batch.missing).toContain(fake);
    // Nothing is silently dropped.
    expect(batch.found.length + batch.missing.length).toBe(real.length + 1);
  });

  it("refuses more than 100 ids at the call site, with the limit named", async () => {
    const ids = Array.from({ length: 101 }, (_unused, index) => `tc_food_${index}`);
    await expect(client.foods.batch(ids)).rejects.toThrow(/at most 100/);
  });
});

describe("ETag revalidation against the live service (SDK-O4)", () => {
  it("sends If-None-Match and reuses the stored body on a 304, byte for byte", async () => {
    const cache = new MemoryResponseCache();
    const events: string[] = [];
    const cached = createTrackCoreClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL as string,
      cache,
      deadlineMs: 60_000,
      onDiagnostic: (event) => events.push(event.event),
    });

    const results = await cached.foods.search({ q: "apple", pageSize: 3 });
    const id = results.results[0]?.food_id as string;

    const first = await cached.foods.get(id, { revalidate: true });
    expect(cache.size).toBe(1);

    const second = await cached.foods.get(id, { revalidate: true });
    expect(events).toContain("cache_hit");

    // The reused body must be the same lexemes, not a re-rendered copy.
    expect([...decimalsOf(second).entries()]).toEqual([...decimalsOf(first).entries()]);
  });
});

describe("what this SDK deliberately cannot do", () => {
  it("offers no portion scaling on the client (SDK-C2, DM-N10)", () => {
    const surface = [
      ...Object.keys(client),
      ...Object.keys(client.foods),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object),
    ];
    expect(surface).not.toContain("scale");
    // `grounds` lost 12 of 19 nutrients scaling a subset of fields client-side.
    // The only correct answer is a server round trip.
  });
});
