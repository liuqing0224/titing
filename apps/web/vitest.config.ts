import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["../../plugins/ops-console/web/src/**/*.{test,spec}.{ts,tsx}"]
  },
  server: {
    fs: {
      allow: ["../.."]
    }
  }
});
