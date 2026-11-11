# TrackCore React Native SDK

A thin, typed client for the TrackCore nutrition API, for React Native and
Expo. **Core only (T-111).** Barcode scanning (T-113), voice→text (T-114) and
health sync (T-119) are separate optional sub-packages, so an app that only
searches for food links no native code.

---

## Two promises this SDK makes

Everything else here is plumbing. These two are the product.

### 1. A number that arrives as `138.000` is still `138.000`

The upstream provider sends `"calories": "72"` — a quoted numeral — and
TrackCore's reason for existing is to return `72`, as a JSON number, with its
scale intact. `JSON.parse` would undo all of it in one line, because it has
exactly one numeric type and it is IEEE-754 binary64:

| wire | `JSON.parse` | lost |
|---|---|---|
| `138.000` | `138` | the stated precision |
| `0.039` | `0.039000000000000000222…` | exactness |
| `19.06` | `19.059999999999998721…` | exactness |
| `9007199254740993` | `9007199254740992` | the value |

So this SDK never calls `JSON.parse` on a response. It uses
`@trackcore/sdk`'s **lexeme-preserving parser**, which hands back a `Decimal`
carrying the exact substring of the response body. A reviver cannot do this:
by the time a reviver runs, the number is already a double.

```ts
const food = await client.foods.get(id);
const amount = food.servings[0].metric_amount;

amount.toString();   // "138.000"   — exact, always
amount.scale;        // 3
amount.toNumber();   // 138         — the lossy conversion, named so you say it out loud
amount.equals(new Decimal("138"));    // true  — same number
amount.identical(new Decimal("138")); // false — not the same datum
```

`Decimal` offers **no arithmetic**, on purpose. If you need to compute outside
what the API offers, hand `.toString()` to `decimal.js` or `big.js` — a
lossless lexeme is exactly what those want as input.

### 2. A secret key never works from a device

Two kinds of credential:

| | |
|---|---|
| `tc_pk_live_…` | **publishable** — safe to ship in your app |
| `tc_sk_live_…` | **secret** — server-side only |

A secret key inside a mobile binary is extractable in minutes: a `.jsbundle` is
a plain file inside an `.ipa` or an `.apk`, and `unzip` plus `strings` is the
whole attack. So:

```ts
createTrackCoreClient({ apiKey: "tc_sk_live_…" });
// ConfigurationError { reason: "secret_key_in_browser" }
```

**Unconditional. No flag, no development bypass, no simulator exception.** The
check reads no global — not `process`, not `navigator`, not `__DEV__` — so
there is nothing a bundler shim, a polyfill preset or a test harness can move.
It is a function of the key string and nothing else.

Use a publishable key in the app and keep the secret key on your own server.

---

## Installation

The package is not on the npm registry. Every release carries the built
package as a tarball, and npm, Bun, pnpm and yarn all install it from the URL
(yarn 2 and later want the package name in front of it):

```sh
npm install https://github.com/TrackCore-S93/trackcore-sdk-react-native/releases/download/v0.3.0/trackcore-react-native-0.3.0.tgz
bun add https://github.com/TrackCore-S93/trackcore-sdk-react-native/releases/download/v0.3.0/trackcore-react-native-0.3.0.tgz
pnpm add https://github.com/TrackCore-S93/trackcore-sdk-react-native/releases/download/v0.3.0/trackcore-react-native-0.3.0.tgz
yarn add https://github.com/TrackCore-S93/trackcore-sdk-react-native/releases/download/v0.3.0/trackcore-react-native-0.3.0.tgz            # yarn 1
yarn add @trackcore/react-native@https://github.com/TrackCore-S93/trackcore-sdk-react-native/releases/download/v0.3.0/trackcore-react-native-0.3.0.tgz     # yarn 2 and later
```

The releases are listed at
https://github.com/TrackCore-S93/trackcore-sdk-react-native/releases; change
`v0.3.0` (twice) to pin another one. The JavaScript SDK this package is built
on (`@trackcore/sdk`) is pinned to its own release tarball in `package.json`,
so it arrives built as well. Installing from git
(`npm install github:TrackCore-S93/trackcore-sdk-react-native#main`) also works
under npm, whose `prepare` step builds `dist/` during the install. Bun does not
run that step, so under Bun only the tarball works.
The optional barcode camera is a separate package,
[`@trackcore/react-native-scanner`](https://github.com/TrackCore-S93/trackcore-sdk-react-native-scanner),
and so is photo capture for a label, a meal or a fridge,
[`@trackcore/react-native-capture`](https://github.com/TrackCore-S93/trackcore-sdk-react-native-capture).

This package has **no native modules of its own**. It imports nothing from
`react-native` at runtime: every platform dependency is injected, which is what
makes SDK-R2's "optional peer dependencies" real rather than aspirational.

- It **works in Expo Go**, because there is nothing to link.
- It needs **no rebuild** to add.
- `@react-native-async-storage/async-storage` is an *optional* peer dependency,
  used only if you want the ETag cache to survive a restart. Adding it is a
  native change and does require a development build.

Camera (T-113), voice (T-114) and health (T-119) are separate packages and
*will* need a rebuild and a development build; Expo Go does not support them
(SDK-R3).

### Supported versions

React Native **0.72+**, Hermes or JavaScriptCore, old or New Architecture.
Nothing here touches the bridge, a TurboModule, a Fabric component or a native
view, so the architecture flag does not apply to this package (SDK-R6). The
sub-packages that *do* ship native code will state their own ranges.

Verified on React Native 0.88 / Expo SDK 58 / Hermes, iOS Simulator, New
Architecture — see **Hermes** below for what was measured and what was not.

---

## Quick start

```ts
import { createTrackCoreClient } from "@trackcore/react-native";

const client = createTrackCoreClient({
  apiKey: "tc_pk_live_…",   // publishable. A tc_sk_ key throws here.
});

const page = await client.foods.search({ q: "apple", pageSize: 20 });

// An empty page is a 200 and means "no matches".
// An outage is a 502 and arrives as DependencyError.
// Never render them the same way (US-10) — a user told "no results" will add a
// wrong custom food instead of retrying.
if (page.results.length === 0) showNoMatches();

const food = await client.foods.get(page.results[0].food_id);

for (const [name, nutrient] of Object.entries(food.servings[0].nutrition)) {
  if (nutrient === null) {
    // The nutrient is modelled and the provider gave no value. It is NOT zero.
    render(name, "not reported");
  } else {
    render(name, `${nutrient.value.toString()} ${nutrient.unit}`);
  }
}
```

A batch read, where the interesting part is the failures:

```ts
const batch = await client.foods.batch(ids);   // at most 100

// Read missing[] BEFORE you act on found[]. Every unresolvable id is in it, in
// request order, and nothing is silently omitted.
for (const id of batch.missing) {
  markUnresolvable(id);   // keep the user's entry; do not delete, do not substitute
}
```

A complete runnable version is in `example/quickstart.ts`
(`npm run example`).

---

## What this SDK will not do

- **No portion scaling, serving normalisation or nutrition summation on the
  client.** Scaling is `POST /v1/foods/scale`, server-side. `grounds`, this
  customer's Flutter app, lost **12 of 19 nutrients** by scaling a subset of
  fields client-side; the rule exists because of that (SDK-C2, DM-N10).
- **No offline support and no write queue.** Decided 2026-10-23: portion edits
  require the network. The cache below revalidates; it never answers alone.
- **No `any` in the public surface** (SDK-R5), and no method that exists only
  to throw "not implemented" (D-004).

---

## Timeouts, retries, and the 502 rule

Two clocks. `timeoutMs` (default 10 s) bounds **one attempt**; `deadlineMs`
(default 30 s) bounds **the whole call**, retries and backoff included.

The retry policy is `@trackcore/sdk`'s, unchanged:

| outcome | retried |
|---|---|
| connect failure, timeout, 408, 429, 503, 504 | yes — up to 3 attempts, full jitter |
| **502 `upstream_unavailable`** | **once, and only once** |
| 500, 400, 401, 403, 404, 410, 422 | no |

The 502 cap is the one interesting decision. `upstream_unavailable` is the
API's catch-all for *every* unplanned dependency failure — which includes the
provider being down (transient) and the provider rejecting a request TrackCore
forwarded, e.g. from a malformed parameter (permanent). From outside they are
**indistinguishable by design**. Retrying blindly turns a request that can
never succeed into a 30-second hang that burns the customer's rate limit, the
provider quota, and on a device a user's battery and metered data.

`Retry-After` is honoured when the server sends one, from the header or from
the envelope's `retry_after_seconds`.

---

## ETag revalidation

Off by default. Revalidation only — **this is not offline support.**

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AsyncStorageResponseCache } from "@trackcore/react-native";

const cache = new AsyncStorageResponseCache({ storage: AsyncStorage });
await cache.hydrate();                 // once, at startup

const client = createTrackCoreClient({ apiKey, cache });
const food = await client.foods.get(id, { revalidate: true });
```

Every read still goes to the server, with `If-None-Match`. A `304` means the
stored body is still correct. There is no TTL, no staleness heuristic and no
serve-while-revalidate: a cache that answers without asking is one step from a
client deciding what a food's nutrition is.

For memory only, pass `new MemoryResponseCache()` instead.

> **Why there is a custom storage codec.** `Decimal.toJSON()` emits the exact
> lexeme through `JSON.rawJSON`, which is ES2025 and **Hermes does not have
> it**. So `AsyncStorage.setItem(key, JSON.stringify(entry))` would write `138`
> where the server sent `138.000`, and a later `304` would serve that back as
> fact. The cache therefore encodes every `Decimal` as a tagged **string**
> before serialising, so no numeric lexeme is ever handed to `JSON.stringify`.
> `Decimal.isExactlyReSerialisable()` returns `false` on Hermes, which is how
> you can check this for yourself.

---

## Identifying your end users

TrackCore never asks you to adopt TrackCore's idea of a user (D-012). You pass
**your own** identifier — a Firebase UID, a row id, a ULID — and the gateway
creates the matching record the first time it sees it, keyed to your account.
There is no "create user" call to await first, and the API only ever speaks
your id back to you.

```ts
auth().onAuthStateChanged((user) => {
  if (user) client.setUser(user.uid);   // at sign-in
  else client.clearUser();              // at sign-out
});

client.externalId;                      // the current id, or null
```

`setUser` is synchronous and makes no network call: it stores a string, and
every request **this client** makes from then on carries it as `X-External-Id`
— the food reads, the label, image and NLP posts, the revalidating `304` reads
and `health()` alike. Before `setUser`, and after `clearUser`, the header is
**not sent at all** rather than sent empty. The gateway cannot tell those two
apart — it reads an absent `X-External-Id` and a present-but-empty one
identically, and both mean "provision nobody" — so omitting it is not a way of
dodging a `400`. It is how a signed-out request keeps one unambiguous shape on
the wire: nothing to misread, and still correct if the blank case is ever
tightened.

Because the client holds the id, this belongs wherever your auth state lives —
one client for the app, told who is signed in — rather than being threaded
through every screen that calls the SDK.

A bad id throws `ConfigurationError` on the spot, before anything is sent, with
a `reason` naming the rule it broke: whitespace-padded, empty, over 255 Unicode
code points, or outside printable ASCII. **The rules and the reasons are the
JavaScript SDK's** — this package re-exports them rather than restating them,
which is what keeps the three SDKs from drifting — so the table and the full
argument for the ASCII rule are in the [JavaScript SDK README][js-identity], under
"Identifying your end users". The short version: an HTTP header is bytes, a
code point in `U+0080`–`U+00FF` goes out as one Latin-1 byte and arrives as a
*different, valid-looking* id, and that provisions a second user and splits one
person's history in two without failing or logging anything.

`assertValidExternalId`, `EXTERNAL_ID_HEADER` and `EXTERNAL_ID_MAX_CODE_POINTS`
are exported from this package too, so a sign-in screen can apply the same
check at its own boundary:

```ts
import { assertValidExternalId } from "@trackcore/react-native";
```

**Deleting an account.** When a user deletes their account, their TrackCore
data has to go too. That is `DELETE /v1/users/{external_id}` (PF-T5), it needs
the secret key, and so it is **not on this client**: your backend calls
`serverClient.users.delete(uid)` with `@trackcore/sdk` from the same code path
that deletes the account everywhere else, and gets back a receipt counting the
rows removed per table. On the device, `clearUser()` and `clearSession()` are
all that is left to do.

Switching user does **not** clear the ETag cache, and does not need to.
Everything stored is catalogue data — a food's nutrition is identical for every
end user — and nothing user-scoped is written to `AsyncStorage` at all.
Clearing on every sign-in would throw away a warm device cache and make the
next screen pay for a full body over a metered connection. The Flutter SDK
makes the same call.

[js-identity]: https://github.com/TrackCore-S93/trackcore-sdk-js#identifying-your-end-users

---

## Errors

Two families. `TrackCoreAPIError` means the server answered in the contract
envelope and carries a `code` from a **closed 37-code enumeration**, a
`requestId` to quote in a support ticket and a `docsUrl`.
`TrackCoreClientError` means nothing came back, or what came back was not
TrackCore: a DNS failure, a timeout, a captive portal's HTML, a secret key in
an app.

```ts
import {
  DependencyError, MaintenanceError, RateLimitError, ResourceError, isAPIError,
} from "@trackcore/react-native";

try {
  await client.foods.get(id);
} catch (error) {
  if (error instanceof MaintenanceError) showMaintenanceBanner(error.retryAfterSeconds);
  else if (error instanceof DependencyError) showOutage();      // 502 — not "no results"
  else if (error instanceof RateLimitError) backOff(error.retryAfterSeconds);
  else if (error instanceof ResourceError) markGone(error.code); // food_gone vs resource_not_found
  else if (isAPIError(error)) report(error.code, error.requestId);
  else throw error;
}
```

**A raw upstream message never reaches you.** When a response is not a
conforming envelope, the SDK raises `ProtocolError` with fixed text and parks
up to 2 KiB of the body on a non-enumerable `bodySample` — there when you look
for it, absent from `JSON.stringify(err)` and from structured logs.

---

## Hermes

React Native's engine is not Node's, and neither is its `fetch`. Three things
were therefore measured rather than assumed, on a real iOS Simulator running
Hermes with the New Architecture:

1. **Which parser path is live.** Hermes has no ES2025 `JSON.parse` reviver
   source access, so the hand-written lexeme-preserving parser is what runs —
   not the native fast path. Both are lexeme-exact; the SDK reports which one
   you have:

   ```ts
   import { detectReactNativeRuntime, describeRuntime } from "@trackcore/react-native";
   console.log(describeRuntime());
   // engine=hermes reactNative=true fetch=true abortController=true jsonParser=portable
   ```

2. **Whether React Native's networking parses the body first.** It does not.
   React Native's `fetch` is the `whatwg-fetch` polyfill over
   `XMLHttpRequest`; the `Response` holds the raw string and only parses when
   `.json()` is called. This SDK calls `.text()` and never `.json()`, and a
   source-level test enforces that.

3. **Whether the abort signal is honoured.** React Native has honoured it since
   0.60, but a timeout that silently does not fire is worse than no timeout, so
   the adapter **races the signal itself**: if it fires, the call rejects
   immediately whether or not the platform noticed. The underlying request is
   then abandoned rather than cancelled, which costs a socket for the remainder
   of its life.

`example/device-check/` is the harness that checks all of this on a simulator.
It reports **20 / 20** on React Native 0.88 / Expo SDK 58 / Hermes / iOS 26.5
Simulator, driving a live `nutritiond`, including all 1 261 numeric lexemes on
the `apple` page and all 963 on `milk` appearing verbatim in the raw response
body.

### The iOS response store, and why every request says `no-store`

Found on that harness, and **not** findable from Node. Once `NSURLSession` has
state for a URL it manages the conditional headers for that URL itself, and the
SDK's `If-None-Match` does not reach the wire. Measured, same food, same weak
validator:

| request | status |
|---|---|
| conditional `GET`, no cache directive | `200`, full 5 393-byte body |
| …plus `Cache-Control: no-cache` | `200`, full body |
| …plus `Cache-Control: no-store` | `304` |
| the identical request from Node or `curl` | `304` |

Each carried a **fresh `X-Request-Id`**, so iOS was not replaying a stored body
— the request reached the server, and the server answered `200` because it saw
no matching validator.

So the adapter sends `Cache-Control: no-store` on every request, which is also
a true statement of this SDK's policy: it keeps its own validator store, it has
no offline mode, and a second invisible copy of a response on the device is
exactly what DM-F5 is about.

**Known limit.** The effect is tied to a URL's history within the app's
lifetime. A URL fetched once by a plain `fetch` with no cache directive stopped
honouring the SDK's `If-None-Match` for the rest of that session. Route all
TrackCore traffic through the SDK and revalidation works; mix in your own bare
`fetch` calls to the same URLs and it can stop firing. The exact rule inside
`NSURLSession` was not established — this is observed behaviour, not a reading
of Apple's source. The failure is benign in the way that matters: you still get
a correct, freshly served body and lose only the saved bandwidth. **It is never
stale.**

### What was not verified

Stated plainly rather than implied:

- **Android has not been run.** The code paths are identical — there is no
  `.ios.tsx`/`.android.tsx` anywhere in this package and nothing is
  platform-branched — but "identical by inspection" is not "measured", and the
  `no-store` finding above is specifically an iOS one.
- **No physical device.** Simulator only. ATS, cellular timeouts and background
  suspension differ on hardware.
- **JavaScriptCore has not been run.** Both parser paths are lexeme-exact and
  the SDK reports which one is live, but the measurements above are Hermes'.
- **Expo Go has not been run.** This package links no native code so it should
  work there; the harness was a development build.

---

## Layout

```
src/
  index.ts         the public surface; mostly re-exports from @trackcore/sdk
  client.ts        TrackCoreClient — a thin wrapper over the shared client
  credentials.ts   the unconditional secret-key refusal          ← specialised
  fetch.ts         the React Native fetch adapter                ← specialised
  cache.ts         AsyncStorage-backed ETag store + codec        ← specialised
  environment.ts   runtime diagnostics. NOT a security control
test/
  credentials.test.ts      the refusal, and the BUG-022 class of hole
  shared-core.test.ts      object-identity proof that nothing is forked
  identity.test.ts         setUser/clearUser: the header, and the pass-through
  source-rules.test.ts     greps: no JSON.parse on a response path, no DOM, no scaling
  cache.test.ts            the storage codec and the write-behind queue
  fetch.test.ts            the abort race and the text-only body rule
  beyond-safe-integer.test.ts  9007199254740993 over a real socket
  live.test.ts             the real nutrition service. The test that counts.
example/
  quickstart.ts            T-117's RN half — runs under Node in four seconds
  device-check/            the Hermes + simulator harness
```

**This package forks nothing.** The transport, retry policy, error mapping,
decimal parser, credential holder, ETag logic and model decode are
`@trackcore/sdk`'s, imported and used unmodified — `test/shared-core.test.ts`
asserts they are the *same object identities*, so a stray second copy fails the
suite. Models are re-exported, never redeclared, so T-107's generated output
drops in with no edit here.

---

## Running the tests

```sh
npm run typecheck
npm test                     # 129 tests, no network

# the one that counts: against a real nutrition service
go build -o /tmp/nutd ./services/nutrition/cmd/nutritiond
NUTRITION_LISTEN_ADDR=127.0.0.1:9733 FOOD_API_BASE_URL=… FOOD_API_KEY=… /tmp/nutd &
lsof -nP -iTCP:9733 -sTCP:LISTEN     # confirm it is the binary you just built
TRACKCORE_LIVE_BASE_URL=http://127.0.0.1:9733 npm run test:live
```

Green tests have not historically predicted correctness in this codebase — a
service here once passed 230 tests against a parser that could not read a
single live response. Drive the real service.
