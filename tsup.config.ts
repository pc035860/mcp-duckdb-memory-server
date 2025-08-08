/// <reference types="node" />
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "tools/merge-duckdb": "src/tools/merge-duckdb.ts",
    "tools/repair-database": "src/tools/repair-database.ts",
    "tools/migrate-database": "src/tools/migrate-database.ts",
  },
  format: "esm",
  outExtension: () => ({
    js: ".mjs",
  }),
});
