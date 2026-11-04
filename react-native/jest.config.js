/**
 * Jest, not Vitest.
 *
 * `@trackcore/sdk` uses Vitest, which is right for a package that targets Node
 * and browsers. This package targets React Native, where Jest is the ecosystem
 * default and the `react-native` preset is what a customer's own tests run
 * under; matching that means a bug reproduced in a customer's repo reproduces
 * here.
 *
 * The preset itself is **not** used, because this package imports no React
 * Native module at runtime — every platform dependency is injected
 * (`AsyncStorageLike`, `FetchLike`), which is what makes SDK-R2's "optional
 * peer dependencies" real rather than aspirational. Pulling in
 * `react-native/jest-preset` would link the very native code the design avoids
 * and would make a passing suite prove less, not more.
 *
 * The live suite is excluded by default: it drives a real nutrition service and
 * needs `TRACKCORE_LIVE_BASE_URL`. Run it with `npm run test:live`.
 *
 * `globalSetup` builds `@trackcore/sdk` first, because this suite resolves it
 * to `../js/dist/index.cjs` and nothing else was building it — a green run
 * here certified whatever `dist` happened to contain (BUG-025). The whole
 * argument, including why the dependency is built rather than path-mapped to
 * `../js/src`, is at the top of `jest.global-setup.js`.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  globalSetup: "<rootDir>/jest.global-setup.js",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  testPathIgnorePatterns: process.env.TRACKCORE_LIVE_BASE_URL ? [] : ["/test/live\\.test\\.ts$"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};
