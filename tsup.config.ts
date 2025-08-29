/// <reference types="node" />
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "tools/merge-duckdb": "src/tools/merge-duckdb.ts",
    "tools/repair-database": "src/tools/repair-database.ts",
    "tools/migrate-database": "src/tools/migrate-database.ts",
    "tools/backfill-embeddings": "src/tools/backfill-embeddings.ts",
  },
  format: "esm",
  outExtension: () => ({
    js: ".mjs",
  }),
  // Copy SQL migration files to dist
  publicDir: false,
  onSuccess: async () => {
    const fs = await import('fs');
    const path = await import('path');
    
    // Create migrations directory in dist
    const distMigrationsDir = path.join('dist', 'migrations');
    if (!fs.existsSync(distMigrationsDir)) {
      fs.mkdirSync(distMigrationsDir, { recursive: true });
    }
    
    // Copy migration files
    const srcMigrationsDir = path.join('src', 'migrations');
    const files = fs.readdirSync(srcMigrationsDir);
    
    for (const file of files) {
      if (file.endsWith('.sql')) {
        const srcPath = path.join(srcMigrationsDir, file);
        const distPath = path.join(distMigrationsDir, file);
        fs.copyFileSync(srcPath, distPath);
        console.log(`Copied ${file} to dist/migrations/`);
      }
    }
  }
});
