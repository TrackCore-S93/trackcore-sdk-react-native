# The on-device verification harness

`App.tsx` in this folder is a complete React Native app that checks the two
claims a Jest run cannot establish:

1. **Nothing in React Native's networking layer parses the response body**
   before the lexeme-preserving parser sees it — so `138.000` reaches your code
   as the characters the server sent, not as a double.
2. **A `tc_sk_` key is refused on a real device runtime**, not just under Node.

Plus the things that depend on the engine rather than the API: which JSON
parser path Hermes selects, whether `JSON.rawJSON` exists (it does not, which
is why the ETag cache has a custom codec), and whether the abort signal and
`AbortController` are present.

It drives the **real nutrition service** against the **real upstream provider**.
Nothing in it is mocked. A fixture would prove only that the fixture
round-trips — and a service in this codebase once passed 230 tests against a
parser that could not read a single live response.

---

## Running it

### 1. A nutrition service, on a port nobody else is using

```sh
cd <repo root>
go build -o /tmp/nutd ./services/nutrition/cmd/nutritiond
NUTRITION_LISTEN_ADDR=127.0.0.1:9733 \
  FOOD_API_BASE_URL=https://api.studio93.io/food \
  FOOD_API_KEY=<the provider key — never commit it> \
  /tmp/nutd &
```

**Confirm the listener is the binary you just built** before you believe any
number that comes out of this:

```sh
lsof -nP -iTCP:9733 -sTCP:LISTEN          # note the pid
ps -o comm= -p <pid>                      # must be the /tmp/nutd you just built
```

A stale process on a reused port once made QA report four fixed defects as
still broken, with entirely plausible numbers.

### 2. An app to put this file in

```sh
npx create-expo-app@latest rnharness --template blank-typescript
cd rnharness
npx expo install react-native-safe-area-context
npm install @trackcore/react-native
cp <repo>/sdks/react-native/example/device-check/App.tsx ./App.tsx
```

If you are working from the monorepo rather than a published package, build the
SDK (`npm run build` in `sdks/react-native`) and copy `package.json` + `dist/`
for both `@trackcore/react-native` and `@trackcore/sdk` into the app's
`node_modules/@trackcore/`. Copying rather than symlinking keeps Metro out of
the symlink-resolution question entirely, and it means the thing under test is
the built artifact a customer would get.

### 3. Run it

```sh
EXPO_PUBLIC_TRACKCORE_BASE_URL=http://127.0.0.1:9733 \
EXPO_PUBLIC_TRACKCORE_COLLECTOR=http://127.0.0.1:9734/report \
  npx expo run:ios --device "iPhone 17 Pro"
```

The iOS Simulator shares the host's network stack, so `127.0.0.1` from inside
the app is your Mac.

On a real device, or on Android, replace `127.0.0.1` with the Mac's LAN address
(the Android emulator reaches the host at `10.0.2.2`).

### 4. Read the result

Every check renders on screen with a PASS/FAIL badge. If anything is listening
on `EXPO_PUBLIC_TRACKCORE_COLLECTOR`, the app also POSTs the whole report as
JSON, which is what a CI run should read:

```python
# collector.py
import http.server, pathlib, sys
OUT = pathlib.Path(sys.argv[1])

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        OUT.write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(204); self.send_header("Content-Length","0"); self.end_headers()
    def log_message(self, *a): pass

http.server.HTTPServer(("127.0.0.1", 9734), H).serve_forever()
```

Every check is also written to the console with a `[trackcore-check]` prefix,
so `npx react-native log-ios` works if you would rather not run a collector.

---

## Troubleshooting

**`pod install` fails with `Unicode Normalization not appropriate for
ASCII-8BIT`.** A locale problem, not a CocoaPods one. Run it as
`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install`.

**Every live check fails with a connection error.** The app cannot reach the
service. Check `curl http://127.0.0.1:9733/healthz` on the host first, then
that you passed the same port to `EXPO_PUBLIC_TRACKCORE_BASE_URL`. On a
physical device `127.0.0.1` is the *phone*, not your Mac.

**`runtime is Hermes` fails.** The app is on JavaScriptCore. The SDK works
either way — both parser paths are lexeme-exact — but the Hermes-specific
claims in the report are then unverified, so say so rather than reporting a
pass.

---

## What this harness does *not* check

- **Android.** The code paths are identical — nothing in this package is
  platform-specific, there is no `.ios.tsx`/`.android.tsx` anywhere, and the
  networking differences are inside React Native's own polyfill. But "identical
  by inspection" is not "measured", and an Android run is the only thing that
  closes it.
- **A physical device.** Only the simulator. ATS, cellular timeouts and
  background suspension all behave differently on hardware.
- **Expo Go.** This package works in Expo Go because it links no native code;
  the harness has only been run as a development build.
