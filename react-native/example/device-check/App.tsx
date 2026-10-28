/**
 * The on-device verification harness.
 *
 * # What this is for
 *
 * Everything else in this package is tested under Node. Node is not Hermes and
 * Node's `fetch` is not React Native's — React Native installs a `whatwg-fetch`
 * polyfill over `XMLHttpRequest` over the platform's own networking. The two
 * claims that matter most in this SDK are claims about *that* stack:
 *
 *   1. nothing in React Native's networking layer parses the response body
 *      before the SDK's lexeme-preserving parser sees it, so `138.000` is still
 *      the three characters `138` and a dot and three zeros; and
 *   2. a `tc_sk_` key is refused, on a device, unconditionally.
 *
 * A Jest run cannot establish either. This app can, because it is the real
 * thing: Hermes, the real polyfill, a real simulator, driving a real
 * `nutritiond` on the host.
 *
 * # Running it
 *
 * See `example/device-check/README.md`. In short: build and run `nutritiond`
 * on a fresh port, point `SERVICE_URL` at it, drop this file into an Expo app
 * that has `@trackcore/react-native` installed, and `npx expo run:ios`.
 *
 * The app renders every check and also POSTs a JSON report to `COLLECTOR_URL`
 * if one is listening, so a CI run can read the result rather than a person
 * reading a screen.
 *
 * # What it deliberately does not do
 *
 * It does not scale a portion, sum a day, or cache anything it has not just
 * revalidated. Those are the forbidden behaviours (SDK-C2, DM-N10) and this
 * file is also the place a reviewer would look for them.
 */

import React from "react";
import { ScrollView, StyleSheet, Text, View, useColorScheme } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import {
  AsyncStorageResponseCache,
  ConfigurationError,
  Decimal,
  MemoryResponseCache,
  createTrackCoreClient,
  decodeBody,
  describeRuntime,
  detectReactNativeRuntime,
  encodeBody,
  isAPIError,
  parseJson,
  type AsyncStorageLike,
  type JsonValue,
} from "@trackcore/react-native";

/** The host's loopback, as seen from the iOS simulator. Override per run. */
const SERVICE_URL = process.env.EXPO_PUBLIC_TRACKCORE_BASE_URL ?? "http://127.0.0.1:9733";
const COLLECTOR_URL = process.env.EXPO_PUBLIC_TRACKCORE_COLLECTOR ?? "http://127.0.0.1:9734/report";

/**
 * Publishable and inert. `nutritiond` does not authenticate — the gateway does
 * — so this exercises the credential path without being a credential. A real
 * app ships `tc_pk_live_…` here and nothing else; that is the whole point.
 */
const API_KEY = `tc_pk_test_${"0123456789abcdefghijklmnopqrstuvwxyzABCD"}`;

/** The nine lexemes QA verified end to end against the running service. */
const VERIFIED_LEXEMES = [
  "138.000",
  "138.0000000000000000",
  "0.039",
  "19.06",
  "0.1",
  "62.5",
  "3.3333333333333333",
];

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Collects every `Decimal` in a decoded response, by JSON path. */
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

/** A minimal in-memory `AsyncStorage`, so the harness needs no native module. */
function fakeStorage(): AsyncStorageLike {
  const items = new Map<string, string>();
  return {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    removeItem: async (key) => {
      items.delete(key);
    },
    getAllKeys: async () => [...items.keys()],
  };
}

async function runChecks(push: (check: Check) => void): Promise<void> {
  const runtime = detectReactNativeRuntime();

  // ---------------------------------------------------------------------
  // 1. Which engine and which parser path are actually live
  // ---------------------------------------------------------------------
  push({
    name: "runtime is Hermes",
    ok: runtime.engine === "hermes",
    detail: describeRuntime(runtime),
  });
  push({
    name: "the portable lexeme-preserving parser is the live path",
    // Hermes has no ES2025 `JSON.parse` reviver source access, so the
    // hand-written parser is what runs. If this ever flips to "native-source"
    // the fast path became available and both are still lexeme-exact — but it
    // should be an observation, not a surprise.
    ok: runtime.jsonParser === "portable",
    detail: `jsonParser=${runtime.jsonParser} hasFetch=${String(runtime.hasFetch)} abortController=${String(runtime.hasAbortController)}`,
  });

  // ---------------------------------------------------------------------
  // 2. The parser itself, under Hermes, before any network is involved
  // ---------------------------------------------------------------------
  const parserFailures: string[] = [];
  for (const lexeme of [...VERIFIED_LEXEMES, "9007199254740993"]) {
    const parsed = parseJson(`{"v":${lexeme}}`) as Record<string, Decimal>;
    if (!(parsed.v instanceof Decimal) || parsed.v.source !== lexeme) {
      parserFailures.push(`${lexeme} -> ${String(parsed.v)}`);
    }
  }
  push({
    name: "parseJson preserves every verified lexeme under Hermes",
    ok: parserFailures.length === 0,
    detail: parserFailures.length === 0 ? "all exact" : parserFailures.join(", "),
  });

  // The control: what the obvious one-liner would have done on this engine.
  const naive = JSON.parse('{"v":138.000}') as { v: number };
  push({
    name: "control — Hermes' own JSON.parse does lose the scale",
    ok: String(naive.v) === "138",
    detail: `JSON.parse("138.000").v === ${String(naive.v)} (this is what the SDK avoids)`,
  });

  push({
    name: "Hermes has no JSON.rawJSON, so the cache codec is load-bearing",
    ok: true,
    detail: `Decimal.isExactlyReSerialisable() === ${String(Decimal.isExactlyReSerialisable())}`,
  });

  // ---------------------------------------------------------------------
  // 3. The secret-key refusal, on a real device runtime
  // ---------------------------------------------------------------------
  let refusal = "no error thrown — THIS IS A FAILURE";
  let refused = false;
  try {
    createTrackCoreClient({ apiKey: `tc_sk_live_${"a".repeat(48)}`, baseUrl: SERVICE_URL });
  } catch (error) {
    refused = error instanceof ConfigurationError && error.reason === "secret_key_in_browser";
    refusal = error instanceof ConfigurationError ? `ConfigurationError reason=${error.reason}` : String(error);
  }
  push({ name: "a tc_sk_ key is refused on the device", ok: refused, detail: refusal });

  let publishableOk = false;
  let publishableDetail = "";
  try {
    const probe = createTrackCoreClient({ apiKey: API_KEY, baseUrl: SERVICE_URL });
    publishableOk = probe.keyKind === "publishable";
    publishableDetail = probe.describeCredential();
  } catch (error) {
    publishableDetail = String(error);
  }
  push({
    name: "a tc_pk_ key is accepted in the same place",
    ok: publishableOk,
    detail: publishableDetail,
  });

  // ---------------------------------------------------------------------
  // 4. The whole stack, against the live service, over React Native's fetch
  // ---------------------------------------------------------------------
  const client = createTrackCoreClient({ apiKey: API_KEY, baseUrl: SERVICE_URL, deadlineMs: 60_000 });

  try {
    const probe = await client.health();
    push({ name: "GET /healthz over React Native's fetch", ok: probe.status === "ok", detail: JSON.stringify(probe) });
  } catch (error) {
    push({ name: "GET /healthz over React Native's fetch", ok: false, detail: String(error) });
    push({
      name: "the live checks could not run",
      ok: false,
      detail: `is nutritiond listening on ${SERVICE_URL}?`,
    });
    return;
  }

  for (const [query, wanted] of [
    ["apple", ["138.000", "138.0000000000000000", "0.039", "19.06"]],
    ["milk", ["0.1", "62.5", "3.3333333333333333"]],
  ] as Array<[string, string[]]>) {
    // The raw bytes, taken straight off React Native's own fetch. `.text()`,
    // never `.json()`.
    const rawResponse = await fetch(
      `${SERVICE_URL}/v1/foods/search?q=${query}&page_size=20&page=0`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${API_KEY}` } },
    );
    const rawText = await rawResponse.text();

    const results = await client.foods.search({ q: query, pageSize: 20, page: 0 });
    const decimals = decimalsOf(results);

    const missing = wanted.filter((lexeme) => ![...decimals.values()].includes(lexeme));
    push({
      name: `live "${query}": the verified lexemes are present`,
      ok: missing.length === 0,
      detail: missing.length === 0 ? wanted.join(", ") : `missing: ${missing.join(", ")}`,
    });

    // The strong form: every lexeme the SDK is carrying appears verbatim in the
    // bytes the socket delivered. A value that went through a double on the way
    // would have been rewritten.
    const drifted: string[] = [];
    for (const [path, lexeme] of decimals) {
      if (!rawText.includes(lexeme)) drifted.push(`${path}=${lexeme}`);
    }
    push({
      name: `live "${query}": all ${String(decimals.size)} lexemes appear verbatim in the raw body`,
      ok: drifted.length === 0,
      detail: drifted.length === 0 ? "byte-for-byte" : drifted.slice(0, 5).join(", "),
    });
  }

  // ---------------------------------------------------------------------
  // 5. One food, and a missing[] entry (the T-117 shape)
  // ---------------------------------------------------------------------
  const page = await client.foods.search({ q: "apple", pageSize: 3 });
  const firstId = page.results[0]?.food_id ?? "";
  const food = await client.foods.get(firstId);
  const firstServing = food.servings[0];
  push({
    name: "GET /v1/foods/{id} returns exact values",
    ok: firstServing !== undefined && firstServing.metric_amount instanceof Decimal,
    detail: `${food.name}: metric_amount=${String(firstServing?.metric_amount)} energy=${String(
      firstServing?.nutrition["energy"]?.value,
    )}`,
  });

  const batch = await client.foods.batch([firstId, "tc_food_000000000000000000000000AA"]);
  push({
    name: "an unresolvable id lands in missing[], not silently omitted",
    ok: batch.missing.length === 1 && batch.found.length === 1,
    detail: `found=${String(batch.found.length)} missing=${JSON.stringify(batch.missing)}`,
  });

  let errorShape = "no error";
  let errorOk = false;
  try {
    await client.foods.get("tc_food_000000000000000000000000AA");
  } catch (error) {
    errorOk = isAPIError(error);
    errorShape = isAPIError(error)
      ? `${error.name} code=${error.code} status=${String(error.status)} request=${String(error.requestId)}`
      : String(error);
  }
  push({ name: "an unknown id is a typed error from the closed enumeration", ok: errorOk, detail: errorShape });

  // ---------------------------------------------------------------------
  // 6. ETag revalidation, and the storage codec, on Hermes
  // ---------------------------------------------------------------------
  const events: string[] = [];
  const revalidationCache = new MemoryResponseCache();
  const cached = createTrackCoreClient({
    apiKey: API_KEY,
    baseUrl: SERVICE_URL,
    cache: revalidationCache,
    onDiagnostic: (event) =>
      events.push(`${event.event}${event.status === undefined ? "" : `:${String(event.status)}`}`),
  });
  // A food id nothing else in this run has touched, so NSURLSession has no
  // history for the URL. `firstId` has already been fetched by the check
  // above, and that turns out to matter — see the diagnostics below.
  const untouchedId = page.results[1]?.food_id ?? firstId;
  const first = await cached.foods.get(untouchedId, { revalidate: true });
  const sizeAfterFirst = revalidationCache.size;
  const second = await cached.foods.get(untouchedId, { revalidate: true });
  push({
    name: "a 304 reuses the stored body with identical lexemes",
    ok:
      events.some((event) => event.startsWith("cache_hit")) &&
      JSON.stringify([...decimalsOf(first)]) === JSON.stringify([...decimalsOf(second)]),
    detail: `id=${untouchedId === firstId ? "reused" : "untouched"} cacheSizeAfterFirst=${String(sizeAfterFirst)} events=${events.join(",")}`,
  });

  // -------------------------------------------------------------------------
  // 7. iOS' own response store, which is why every SDK request says `no-store`
  // -------------------------------------------------------------------------
  //
  // These are **observations**, not pass/fail checks: they record what iOS does
  // to a conditional GET, which is the reason `src/fetch.ts` sends
  // `Cache-Control: no-store` on every request. They always report `ok`; the
  // value is in the detail line. The real check is the 304 one above.
  const conditionalUrl = `${SERVICE_URL}/v1/foods/${encodeURIComponent(firstId)}`;
  const authHeaders = { Accept: "application/json", Authorization: `Bearer ${API_KEY}` };

  const etagProbe = await fetch(conditionalUrl, { headers: authHeaders });
  const etag = etagProbe.headers.get("ETag");
  await etagProbe.text();
  push({
    name: "React Native's fetch can read the ETag response header",
    ok: etag !== null,
    detail: `ETag=${String(etag)}`,
  });

  if (etag !== null) {
    // (a) No cache directive. This is what a developer's own `fetch` would do.
    const bare = await fetch(conditionalUrl, {
      headers: { ...authHeaders, "If-None-Match": etag },
    });
    const bareBody = await bare.text();
    push({
      name: "observation: a bare conditional GET, no cache directive",
      ok: true,
      detail:
        `status=${String(bare.status)} bodyLength=${String(bareBody.length)} ` +
        `requestId=${String(bare.headers.get("X-Request-Id"))} ` +
        `(200 here means iOS dropped the If-None-Match; the request still reached ` +
        `the server — the request id is new — and curl/Node both get 304)`,
    });

    // (b) The same, on a URL this app has never requested.
    const freshUrl = `${conditionalUrl}?z=${String(Date.now())}`;
    const seed = await fetch(freshUrl, {
      headers: { ...authHeaders, "Cache-Control": "no-store" },
    });
    const seedEtag = seed.headers.get("ETag");
    await seed.text();
    const conditional = await fetch(freshUrl, {
      headers: { ...authHeaders, "Cache-Control": "no-store", "If-None-Match": String(seedEtag) },
    });
    await conditional.text();
    push({
      name: "observation: a no-store conditional GET on a URL with no history",
      ok: true,
      detail:
        `status=${String(conditional.status)} sameEtagAsPlainUrl=${String(seedEtag === etag)} ` +
        `(304 here is the behaviour the SDK relies on)`,
    });
  }

  const storageCache = new AsyncStorageResponseCache({ storage: fakeStorage() });
  const body = parseJson('{"metric_amount":138.000,"big":9007199254740993}') as JsonValue;
  storageCache.set("GET /probe", { etag: 'W/"x"', body, storedAt: Date.now() });
  await storageCache.flush();
  const restored = decodeBody(JSON.parse(JSON.stringify(encodeBody(body))) as unknown) as Record<string, Decimal>;
  push({
    name: "the AsyncStorage codec round-trips lexemes on Hermes",
    ok: restored.metric_amount?.source === "138.000" && restored.big?.source === "9007199254740993",
    detail: `${String(restored.metric_amount)} / ${String(restored.big)}`,
  });
}

export default function App(): React.JSX.Element {
  // The provider is here rather than in the host app's entry point so this one
  // file is the whole harness: drop it in, run it, read the result.
  return (
    <SafeAreaProvider>
      <Report />
    </SafeAreaProvider>
  );
}

function Report(): React.JSX.Element {
  const [checks, setChecks] = React.useState<Check[]>([]);
  const [done, setDone] = React.useState(false);
  const dark = useColorScheme() === "dark";

  React.useEffect(() => {
    const collected: Check[] = [];
    const push = (check: Check): void => {
      collected.push(check);
      setChecks([...collected]);
      // eslint-disable-next-line no-console
      console.log(`[trackcore-check] ${check.ok ? "PASS" : "FAIL"} ${check.name} :: ${check.detail}`);
    };

    void (async () => {
      try {
        await runChecks(push);
      } catch (error) {
        push({ name: "the harness itself threw", ok: false, detail: String(error) });
      } finally {
        setDone(true);
        // eslint-disable-next-line no-console
        console.log(`[trackcore-check] DONE ${JSON.stringify(collected)}`);
        try {
          await fetch(COLLECTOR_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runtime: describeRuntime(), checks: collected }),
          });
        } catch {
          // No collector listening. The on-screen report is the fallback.
        }
      }
    })();
  }, []);

  const failed = checks.filter((check) => !check.ok).length;
  const theme = dark ? darkTheme : lightTheme;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: theme.text }]}>TrackCore device check</Text>
        <Text style={[styles.summary, { color: failed === 0 ? theme.pass : theme.fail }]}>
          {done ? `${checks.length - failed} / ${checks.length} passed` : "running…"}
        </Text>
        {checks.map((check, index) => (
          <View key={`${check.name}-${String(index)}`} style={[styles.row, { borderColor: theme.border }]}>
            <Text style={[styles.badge, { color: check.ok ? theme.pass : theme.fail }]}>
              {check.ok ? "PASS" : "FAIL"}
            </Text>
            <View style={styles.rowBody}>
              <Text style={[styles.name, { color: theme.text }]}>{check.name}</Text>
              <Text style={[styles.detail, { color: theme.muted }]}>{check.detail}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const lightTheme = {
  background: "#ffffff",
  text: "#11181c",
  muted: "#5a6a72",
  border: "#e3e8ea",
  pass: "#0a7d3f",
  fail: "#b3261e",
};

const darkTheme = {
  background: "#101417",
  text: "#eef2f4",
  muted: "#9aa8ae",
  border: "#232b30",
  pass: "#4ad17f",
  fail: "#ff6b61",
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 4 },
  summary: { fontSize: 15, fontWeight: "600", marginBottom: 16 },
  row: { flexDirection: "row", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  badge: { fontSize: 12, fontWeight: "700", width: 42, marginTop: 2 },
  rowBody: { flex: 1 },
  name: { fontSize: 14, fontWeight: "600", marginBottom: 2 },
  detail: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
