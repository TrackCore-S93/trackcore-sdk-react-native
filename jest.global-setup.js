/**
 * Fails fast when `@trackcore/sdk` is not installed with a built `dist`.
 *
 * The dependency is the TrackCore JavaScript SDK, pinned in package.json to
 * the built tarball of one of its releases
 * (`TrackCore-S93/trackcore-sdk-js`). The tarball ships `dist/`, and this
 * package resolves `main` → `dist/index.cjs`, the same pre-bundled file a
 * customer's Metro bundle executes. A missing `dist` means the dependency was
 * installed some other way (a git checkout, which carries no build), and then
 * every test here would be asserting against nothing (BUG-025).
 */

const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

module.exports = function checkTrackCoreSdk() {
  const manifest = require.resolve("@trackcore/sdk/package.json");
  const built = join(dirname(manifest), "dist", "index.cjs");
  if (!existsSync(built)) {
    throw new Error(
      "`@trackcore/sdk` has no dist/index.cjs. Reinstall it (`npm install`) from the " +
        "release tarball package.json names, or run `npm run build` inside " +
        dirname(manifest) + ".",
    );
  }
};
