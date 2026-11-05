/**
 * Fails fast when `@trackcore/sdk` is not installed with a built `dist`.
 *
 * The dependency is the TrackCore JavaScript SDK, pulled from its own
 * repository (`TrackCore-S93/trackcore-sdk-js`). Its `prepare` script builds
 * `dist/` on install, and this package resolves `main` → `dist/index.cjs`,
 * the same pre-bundled file a customer's Metro bundle executes. A missing
 * `dist` means `npm install` did not run the build, and then every test here
 * would be asserting against nothing (BUG-025).
 */

const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

module.exports = function checkTrackCoreSdk() {
  const manifest = require.resolve("@trackcore/sdk/package.json");
  const built = join(dirname(manifest), "dist", "index.cjs");
  if (!existsSync(built)) {
    throw new Error(
      "`@trackcore/sdk` has no dist/index.cjs. Reinstall it (`npm install`) so its " +
        "prepare script builds the package, or run `npm run build` inside " +
        dirname(manifest) + ".",
    );
  }
};
