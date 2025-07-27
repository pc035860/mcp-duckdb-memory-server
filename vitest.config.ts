import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Run tests serially to avoid database file conflicts
    fileParallelism: false,
    // Each test gets fresh environment
    isolate: true,
    // Increase timeout for database operations
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      reporter: ["text", "json", "html"],
    },
    // Global setup/teardown for better resource management
    globalSetup: "./tests/setup.ts",
  },
});
