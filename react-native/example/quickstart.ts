/**
 * T-117's React Native half: create a client, search, read one food, handle a
 * `missing[]` entry.
 *
 * # Why this one runs under Node
 *
 * This file is the *API* walkthrough, and the API is identical on a device and
 * off it — that is the point of the whole SDK being a thin HTTP client. Running
 * it under Node means a developer can read it, run it, and see real numbers in
 * about four seconds without a simulator, an Xcode toolchain or a provisioning
 * profile.
 *
 * The things that are **not** identical under Node — Hermes' JSON engine and
 * React Native's `fetch` polyfill — are not exercised here and this file would
 * be dishonest if it implied they were. They are verified by
 * `example/device-check/`, which is a real app on a real simulator. Read that
 * one for the platform claims; read this one for how the API is used.
 *
 * # Running it
 *
 *     go build -o /tmp/nutd ./services/nutrition/cmd/nutritiond
 *     NUTRITION_LISTEN_ADDR=127.0.0.1:9733 FOOD_API_BASE_URL=… FOOD_API_KEY=… /tmp/nutd &
 *     cd sdks/react-native
 *     TRACKCORE_BASE_URL=http://127.0.0.1:9733 npx ts-node example/quickstart.ts
 *
 * Point `TRACKCORE_BASE_URL` at your own deployment and set `TRACKCORE_API_KEY`
 * to a publishable key to run it against that instead.
 */

import {
  BATCH_MAX_IDS,
  ConfigurationError,
  Decimal,
  DependencyError,
  MaintenanceError,
  RateLimitError,
  ResourceError,
  createTrackCoreClient,
  isAPIError,
  type Food,
  type Serving,
} from "../src";

const BASE_URL = process.env["TRACKCORE_BASE_URL"] ?? "https://api.trackcore.dev";

/**
 * **A publishable key.** `tc_pk_live_…` or `tc_pk_test_…`.
 *
 * A `tc_sk_` key throws from the constructor below, on every device, with no
 * way to turn it off. Secret keys belong on your own server; a key inside an
 * .ipa or an .apk is extractable in minutes.
 */
const API_KEY = process.env["TRACKCORE_API_KEY"] ?? `tc_pk_test_${"0123456789abcdefghijklmnopqrstuvwxyzABCD"}`;

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. The client. One per application; it holds no connection.
  // -------------------------------------------------------------------------
  const client = createTrackCoreClient({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    // Per-attempt and overall budgets. The defaults (10 s / 30 s) are usually
    // right; a device on a flaky connection may want a longer deadline and the
    // same per-attempt timeout.
    timeoutMs: 10_000,
    deadlineMs: 30_000,
  });

  console.log(`client: ${client.describeCredential()} (${client.environment})`);

  // -------------------------------------------------------------------------
  // 2. Search
  // -------------------------------------------------------------------------
  const page = await client.foods.search({ q: "apple", pageSize: 5, page: 0 });

  // An empty page is a 200 and means "no matches". An outage is a 502 and
  // arrives as DependencyError. Never render them the same way (US-10): a
  // user told "no results" will add a wrong custom food instead of retrying.
  if (page.results.length === 0) {
    console.log("no matches for that query");
    return;
  }

  console.log(
    `found ${String(page.total_results)} results, showing page ${String(page.page)} ` +
      `of ${String(page.page_size)}${page.page_size_clamped ? " (page size was clamped by the server)" : ""}`,
  );
  for (const food of page.results) {
    console.log(`  ${food.food_id}  ${food.name}${food.brand === null ? "" : ` — ${food.brand}`}`);
  }

  // -------------------------------------------------------------------------
  // 3. Read one food, and look at the numbers
  // -------------------------------------------------------------------------
  const first = page.results[0] as Food;
  const food = await client.foods.get(first.food_id);

  const serving =
    food.servings.find((candidate) => candidate.serving_id === food.default_serving_id) ??
    (food.servings[0] as Serving);

  console.log(`\n${food.name} — ${serving.description}`);
  console.log(`  data quality: ${food.data_quality}`); // "partial" is a real state; handle all three

  // `metric_amount` is a Decimal carrying the server's exact lexeme. `138.000`
  // stays `138.000`: the provider reported that figure to three decimal places
  // and the precision is part of the datum.
  //
  // It is nullable, and the null is not a formality — a food whose
  // `data_quality` is `"partial"` has servings with no honest metric amount at
  // all. Rendering that as `0 g` would invent a fact.
  console.log(
    serving.metric_amount === null
      ? "  metric amount: not available for this serving"
      : `  metric amount: ${serving.metric_amount.toString()} ${String(serving.metric_unit)}`,
  );

  for (const [name, nutrient] of Object.entries(serving.nutrition)) {
    if (nutrient === null) {
      // DM-N2's third state: the nutrient is modelled and the provider gave no
      // value. It is **not** zero, and rendering it as 0 is a lie about food.
      console.log(`  ${name.padEnd(22)} not reported`);
      continue;
    }
    // `.toString()` is exact. `.toNumber()` is the lossy conversion and is a
    // named method so that losing precision is something the code says aloud.
    console.log(`  ${name.padEnd(22)} ${nutrient.value.toString()} ${nutrient.unit}`);
  }

  // There is no `scale()` here and there will not be one. Scaling a portion is
  // a server call (SDK-C2, DM-N10): the moment a client multiplies nutrients by
  // a quantity there are two implementations of the product's core promise.
  // `grounds` lost 12 of 19 nutrients doing exactly that.

  // -------------------------------------------------------------------------
  // 4. A batch read, and the missing[] entry
  // -------------------------------------------------------------------------
  const ids = [...page.results.map((item) => item.food_id), "tc_food_000000000000000000000000AA"];
  console.log(`\nbatch reading ${String(ids.length)} ids (the server takes up to ${String(BATCH_MAX_IDS)})`);

  const batch = await client.foods.batch(ids);

  // **Read missing[] before you act on found[].** Every unresolvable id is in
  // it, in request order, and nothing is silently omitted — so a diary
  // migration can tell "this entry is gone" from "this entry is fine".
  for (const id of batch.missing) {
    console.log(`  MISSING ${id} — the provider no longer resolves this id`);
    // In a real app: keep the user's logged entry, mark it unresolvable, and
    // offer to re-pick the food. Do not delete it and do not substitute one.
  }
  console.log(`  ${String(batch.found.length)} resolved, ${String(batch.missing.length)} missing`);
}

/** Every failure this SDK can produce, and what a UI should do about each. */
function explain(error: unknown): string {
  if (error instanceof ConfigurationError) {
    // Including `secret_key_in_browser` — a build-time mistake, not a runtime one.
    return `configuration (${error.reason}): ${error.message}`;
  }
  if (error instanceof MaintenanceError) {
    // 503, and the only 503 in the API: TrackCore turned a capability off on
    // purpose. Show a maintenance banner, not an error toast.
    return `maintenance: retry after ${String(error.retryAfterSeconds)}s`;
  }
  if (error instanceof DependencyError) {
    // 502: something TrackCore depends on broke. Not "no results".
    return `upstream unavailable (${String(error.fields.upstream)}) — this is an outage, not an empty result`;
  }
  if (error instanceof RateLimitError) {
    return `rate limited: retry after ${String(error.retryAfterSeconds)}s`;
  }
  if (error instanceof ResourceError) {
    return `${error.code}: ${error.message}`;
  }
  if (isAPIError(error)) {
    // The code is from a closed enumeration, so this switch can be exhaustive.
    return `${error.code} (${error.category}) request_id=${String(error.requestId)} — ${error.docsUrl}`;
  }
  return `client-side: ${String(error)}`;
}

main().catch((error: unknown) => {
  console.error(explain(error));
  process.exitCode = 1;
});

export { explain, Decimal };
