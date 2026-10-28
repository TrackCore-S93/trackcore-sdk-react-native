/**
 * Rules this package's **source text** must satisfy.
 *
 * Two lessons this codebase learned expensively sit behind this file: a service
 * here once passed 230 tests against a parser that could not read a single live
 * response, and a mutation doing the most explicitly forbidden thing in the PRD
 * passed the whole suite. Behavioural tests did not catch either, because both
 * were a line of code that no test happened to execute.
 *
 * So these are greps. They do not prove the SDK works; they prove specific
 * lines are absent, which is the only way to catch a reintroduction that no
 * test exercises. They are a complement to `test/live.test.ts`, never a
 * substitute for it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");

function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));
}

/** Strips block and line comments, so a rule is about code and not prose. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no naive JSON parsing on a response path", () => {
  const files = sourceFiles();

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it("never calls `.json()` on a response", () => {
    // React Native's fetch polyfill holds the raw string and only parses when
    // `.json()` is called — `JSON.parse(this._bodyText)`. One such call and
    // `138.000` is a double before the SDK ever sees it.
    for (const file of files) {
      expect(code(file.text)).not.toMatch(/\.json\s*\(\s*\)/);
    }
  });

  it("calls JSON.parse in exactly one place, and that place is the cache codec", () => {
    const callers = files.filter((file) => /JSON\.parse\s*\(/.test(code(file.text)));
    expect(callers.map((file) => file.name)).toEqual(["cache.ts"]);
  });

  it("the cache's JSON.parse reads this package's own storage format, never a response", () => {
    // `encodeBody` leaves no JSON number behind — every Decimal becomes a
    // tagged string and `storedAt` is stored as a string — so the native parser
    // has no lexeme to flatten. `cache.test.ts` asserts that property on real
    // data; this asserts the two functions stayed together.
    const cache = code(readFileSync(join(SRC, "cache.ts"), "utf8"));
    expect(cache).toContain("decodeBody");
    expect(cache).toContain("encodeBody");
    // And the decoder refuses a bare number rather than coercing one.
    expect(cache).toMatch(/typeof value === "number"[\s\S]{0,400}throw new TypeError/);
  });

  it("never sets a non-text responseType", () => {
    for (const file of files) {
      expect(code(file.text)).not.toMatch(/responseType\s*[:=]/);
      expect(code(file.text)).not.toMatch(/\.(blob|arrayBuffer|formData)\s*\(\s*\)/);
    }
  });
});

describe("no browser assumptions", () => {
  // The tsconfig includes the DOM lib so that @trackcore/sdk's fetch-standard
  // types resolve honestly. That is a licence to write a line React Native
  // cannot run, and this is the check that takes it back.
  const FORBIDDEN = [
    "window.",
    "document.",
    "localStorage",
    "sessionStorage",
    "navigator.userAgent",
    "XMLHttpRequest",
    "WorkerGlobalScope",
    "importScripts",
  ];

  it.each(FORBIDDEN)("no source file uses %s", (needle) => {
    for (const file of sourceFiles()) {
      expect(code(file.text)).not.toContain(needle);
    }
  });
});

describe("the forbidden product behaviours are absent from the source", () => {
  // SDK-C2 and DM-N10. `grounds` lost 12 of 19 nutrients by scaling a subset of
  // fields on the client; the rule exists because of that, and the mutation
  // that slipped through this codebase's whole suite was of exactly this kind.
  const FORBIDDEN = [
    "scalePortion",
    "scaleNutrition",
    "normaliseServing",
    "normalizeServing",
    "sumNutrients",
    "offlineQueue",
    "OfflineQueue",
    "replayQueue",
  ];

  it.each(FORBIDDEN)("no source file defines or calls %s", (needle) => {
    for (const file of sourceFiles()) {
      expect(code(file.text)).not.toContain(needle);
    }
  });

  it("no arithmetic is performed on a Decimal anywhere in this package", () => {
    // Decimal offers no arithmetic by design; the only way to do any is to go
    // through the lossy `toNumber()`/`valueOf()`. A multiplication by a
    // quantity is the forbidden thing, and this is where it would appear.
    for (const file of sourceFiles()) {
      expect(code(file.text)).not.toMatch(/\.toNumber\s*\(\s*\)\s*[*/+-]/);
      expect(code(file.text)).not.toMatch(/\btoNumber\s*\(\s*\)\s*\*/);
    }
  });
});

describe("no native module is imported at runtime (SDK-R2)", () => {
  it("imports only @trackcore/sdk and this package's own files", () => {
    const allowed = /^(@trackcore\/sdk|\.\/[a-z-]+)$/;
    for (const file of sourceFiles()) {
      const imports = [...code(file.text).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      for (const specifier of imports) {
        expect({ file: file.name, specifier }).toMatchObject({
          specifier: expect.stringMatching(allowed) as unknown as string,
        });
      }
    }
  });

  it.each([
    "react-native",
    "@react-native-async-storage/async-storage",
    "expo",
    "expo-constants",
    "react-native-vision-camera",
    "@react-native-voice/voice",
    "react-native-health",
  ])("never imports %s", (module) => {
    // Scoped to import and require positions on purpose: `environment.ts`
    // legitimately *reads a global* called `expo` for the Expo Go hint, which
    // is not a dependency on the Expo package and must not be confused for one.
    for (const file of sourceFiles()) {
      const text = code(file.text);
      expect(text).not.toContain(`from "${module}"`);
      expect(text).not.toContain(`require("${module}")`);
      expect(text).not.toContain(`import("${module}")`);
    }
  });
});
