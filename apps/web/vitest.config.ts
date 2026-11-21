import { defineConfig } from "vitest/config";

// Component tests for the dashboards.
//
// jsdom renders React for real, which is the part the HTTP journey test cannot
// reach: it proves the panel does something with the data instead of throwing.
// It is still not a browser -- no CSS layout, no hydration from server HTML -- so
// the Playwright mobile-viewport run the brief asks for is still outstanding.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.tsx"],
    // `tests/dashboard-journey.ts` is a script that needs both servers up; it is not
    // a vitest file and must not be picked up here.
    testTimeout: 15000,
  },
  esbuild: {
    jsx: "automatic",
  },
});
