/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: [
    "<rootDir>/src",
    "<rootDir>/../../packages/core/src",
    "<rootDir>/../../packages/plugin-api/src",
    "<rootDir>/../../plugins/meegle/src",
    "<rootDir>/../../plugins/codex-executor/src",
    "<rootDir>/../../plugins/cursor-executor/src",
    "<rootDir>/../../plugins/local-runtime/src",
    "<rootDir>/../../plugins/ops-console/src"
  ],
  testMatch: ["**/*.spec.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }]
  },
  moduleFileExtensions: ["ts", "js", "json"],
  testPathIgnorePatterns: ["/dist/", "/web/"]
};
