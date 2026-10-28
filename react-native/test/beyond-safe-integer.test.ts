/**
 * `9007199254740993` — one past `Number.MAX_SAFE_INTEGER`.
 *
 * # Why this is a separate file, and what it does and does not prove
 *
 * The other eight QA-verified lexemes are asserted in `test/live.test.ts`
 * against the real nutrition service: `138.000`, `138.0000000000000000`,
 * `0.039` and `19.06` come back on the live `apple` page, and `0.1`, `62.5` and
 * `3.3333333333333333` on the live `milk` page. This one does not appear in
 * live provider data — no real food has an unsafe integer in it — so there is
 * no honest way to make the live service emit it.
 *
 * What this file does instead is drive the **entire SDK stack** over a real
 * HTTP socket: the React Native fetch adapter, `@trackcore/sdk`'s `Transport`,
 * `response.text()`, and the lexeme-preserving parser. Only the origin is
 * substituted, and it answers with bytes shaped like a TrackCore response.
 *
 * So: this is evidence about the SDK's path, not about the live service. Stated
 * plainly because a fixture that is presented as a live result is exactly how a
 * service here once passed 230 tests against a parser that could not read a
 * single live response.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createTrackCoreClient, Decimal, type TrackCoreClient } from "../src";

const BIG = "9007199254740993";

/** Exactly the bytes a server would write. No object is serialised. */
const BODY =
  `{"food_id":"tc_food_0H0MSKADSH7000000000000000","food_type":"search_food","name":"Fixture",` +
  `"brand":null,"servings":[{"serving_id":"fs:1:1","serving_id_version":1,"description":"unit",` +
  `"household_unit":null,"base_quantity":1.000,"metric_amount":138.000,"metric_unit":"g",` +
  `"gram_weight_per_household_unit":138.0000000000000000,"is_metric_default":true,` +
  `"is_synthesised":false,"nutrition":{"energy":{"value":${BIG},"unit":"kcal"},` +
  `"protein":{"value":0.1,"unit":"g"},"saturated_fat":{"value":0.039,"unit":"g"},` +
  `"carbohydrate":{"value":19.06,"unit":"g","basis":"total"},` +
  `"fiber":{"value":3.3333333333333333,"unit":"g"},"sugar":{"value":62.5,"unit":"g"},` +
  `"vitamin_d":null}}],"default_serving_id":"fs:1:1","data_quality":"ok"}`;

let server: Server;
let client: TrackCoreClient;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  client = createTrackCoreClient({
    apiKey: `tc_pk_test_${"9".repeat(48)}`,
    baseUrl: `http://127.0.0.1:${port}`,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("values a double cannot represent survive the whole SDK stack", () => {
  it("carries 9007199254740993 exactly, where JSON.parse would return 9007199254740992", async () => {
    // The control. This is what the SDK would have returned had it used the
    // obvious one-liner anywhere on the response path.
    expect(JSON.parse(`{"v":${BIG}}`).v).toBe(9007199254740992);
    expect(String(JSON.parse(`{"v":${BIG}}`).v)).not.toBe(BIG);

    const food = await client.foods.get("tc_food_0H0MSKADSH7000000000000000");
    const energy = food.servings[0]?.nutrition["energy"];
    expect(energy?.value).toBeInstanceOf(Decimal);
    expect((energy?.value as Decimal).source).toBe(BIG);
    expect((energy?.value as Decimal).toString()).toBe(BIG);
  });

  it("rejects the lossy conversion of an unsafe integer rather than rounding it", async () => {
    const food = await client.foods.get("tc_food_0H0MSKADSH7000000000000000");
    const energy = food.servings[0]?.nutrition["energy"]?.value as Decimal;
    // `toInt()` is for counters, where a double is exact by construction. Asked
    // for one outside the safe range it throws, because a silently rounded
    // calorie total is the failure this type exists to prevent.
    expect(() => energy.toInt()).toThrow(/safe integer range/);
  });

  it("carries the remaining seven verified lexemes over the same socket", async () => {
    const food = await client.foods.get("tc_food_0H0MSKADSH7000000000000000");
    const serving = food.servings[0];
    const nutrition = serving?.nutrition;
    expect((serving?.metric_amount as Decimal).source).toBe("138.000");
    expect((serving?.gram_weight_per_household_unit as Decimal).source).toBe("138.0000000000000000");
    expect((nutrition?.["saturated_fat"]?.value as Decimal).source).toBe("0.039");
    expect((nutrition?.["carbohydrate"]?.value as Decimal).source).toBe("19.06");
    expect((nutrition?.["protein"]?.value as Decimal).source).toBe("0.1");
    expect((nutrition?.["sugar"]?.value as Decimal).source).toBe("62.5");
    expect((nutrition?.["fiber"]?.value as Decimal).source).toBe("3.3333333333333333");
    // DM-N2's third state, over the wire and back.
    expect(nutrition?.["vitamin_d"]).toBeNull();
  });
});
