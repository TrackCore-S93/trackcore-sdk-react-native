/**
 * Builds `@trackcore/sdk` before a single test file is loaded (BUG-025).
 *
 * # What was wrong
 *
 * `node_modules/@trackcore/sdk` is a symlink to `../js`, whose `main` is
 * `dist/index.cjs`. Nothing in this package ever built it. So the suite
 * reported on whatever was last written to `sdks/js/dist`, which could be
 * arbitrarily old — QA deleted the `X-External-Id` write *and* the ASCII rule
 * from `sdks/js/src`, did not rebuild, and all 158 tests here passed. For a
 * package whose entire premise is that it hand-writes nothing and inherits
 * everything, that made a green run certify nothing at all.
 *
 * # Why the build, and not a path mapping to `../js/src`
 *
 * The other option on the table was pointing jest's `moduleNameMapper` (and
 * the tsconfig `paths`) at `../js/src`, which is faster and needs no child
 * process. It was rejected, for three reasons that all point the same way:
 *
 *   1. **`dist` is the contract.** Metro resolves `main` → `dist/index.cjs`,
 *      a single pre-bundled CommonJS file. That file, not `../js/src`, is what
 *      a customer's app executes. Testing the source would leave the one
 *      artifact anybody runs untested, and would hide a whole class of
 *      packaging defect — BUG-026, where `exports.require.types` points at a
 *      file the build never emits, is exactly that class and is open right now.
 *
 *   2. **It would quietly change the compilation.** `../js` is built at ES2022
 *      and uses `#private` fields; this package compiles at ES2020 (see
 *      `tsconfig.json`) because that is what every supported Hermes can run.
 *      Compiling the dependency's source under *this* tsconfig would downlevel
 *      it, and `test/hermes-surface.test.ts` would then be asserting against
 *      output no device ever receives.
 *
 *   3. **The identity assertions would change meaning.** `shared-core.test.ts`
 *      and `identity.test.ts` prove by `toBe` that this package's `Decimal`,
 *      `Transport` and `assertValidExternalId` are the JavaScript SDK's own
 *      objects. That claim is worth making about the published module; about
 *      two ts-jest-transpiled copies of the same source file it is nearly
 *      tautological.
 *
 * The cost is real and is accepted: a test run now depends on another
 * package's build succeeding, and takes about 1.5 s longer. That coupling is
 * not a side effect, it is the fix — a core regression must be able to fail
 * this suite, and it cannot do that unless this suite compiles the core.
 *
 * # Why `globalSetup` rather than a `pretest` script
 *
 * `pretest` only fires for `npm test`. `npx jest`, `jest -t …` and every IDE
 * test runner skip it, and those are how a single test actually gets run while
 * someone is working. Putting the build here makes the guarantee a property of
 * the suite instead of a property of one way of invoking it.
 *
 * `tsc` has no equivalent hook, so `typecheck` and `build` get `pre*` scripts
 * in `package.json` calling the same `build:deps` script. All three resolve
 * `@trackcore/sdk` through `dist`, so all three need it fresh.
 */

const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = function buildTrackCoreSdk() {
  const dependency = join(__dirname, "..", "js");
  try {
    execFileSync("npm", ["--prefix", dependency, "run", "build"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (failure) {
    // The dependency's own output is the useful part; jest's wrapper around a
    // globalSetup throw is not. Print it before failing.
    process.stderr.write(String(failure.stdout ?? ""));
    process.stderr.write(String(failure.stderr ?? ""));
    throw new Error(
      "`@trackcore/sdk` failed to build, so this suite has nothing trustworthy to test " +
        "against — it resolves the dependency to ../js/dist/index.cjs. Fix the build in " +
        "sdks/js and run again. (See jest.global-setup.js for why the build is a " +
        "precondition rather than an assumption.)",
    );
  }
};
