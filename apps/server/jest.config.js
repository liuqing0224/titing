/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: [
    "<rootDir>/src/titing",
    "<rootDir>/../../packages/core/src/titing"
  ],
  testMatch: ["**/*.spec.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }]
  },
  moduleFileExtensions: ["ts", "js", "json"],
  testPathIgnorePatterns: ["/dist/", "/web/", "/plugins/"]
};
