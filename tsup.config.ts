/// <reference types="node" />
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "tools/merge-duckdb": "src/tools/merge-duckdb.ts",
  },
  format: "esm",
  outExtension: () => ({
    js: ".mjs",
  }),
});
