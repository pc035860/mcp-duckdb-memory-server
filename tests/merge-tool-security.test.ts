import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBMergeTool } from "../src/tools/merge-duckdb.js";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { DuckDBInstance } from "@duckdb/node-api";

describe("DuckDBMergeTool - Security Tests", () => {
  let testDir: string;
  let tool: DuckDBMergeTool;

  beforeEach(() => {
    // Create a unique test directory
    const randomId = randomBytes(8).toString("hex");
    testDir = join(tmpdir(), `merge-security-test-${randomId}`);
    mkdirSync(testDir, { recursive: true });
    tool = new DuckDBMergeTool();
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  // Helper to create a minimal DuckDB database
  async function createMinimalDatabase(filepath: string): Promise<void> {
    // Use the manager to create the database properly with WAL checkpoint
    const { DuckDBKnowledgeGraphManager } = await import("../src/managers/duckdb-manager.js");
    const manager = new DuckDBKnowledgeGraphManager(() => filepath);
    await manager.initialize();
    // The initialize method creates the schema
    // Close the manager to ensure WAL is checkpointed
    await manager.close();
  }

  describe("SQL Injection Prevention", () => {
    it("should properly escape single quotes in SQL strings", async () => {
      // Test the escape function directly
      const toolAny = tool as any;
      expect(toolAny.escapeSQLString("test'with'quotes")).toBe("test''with''quotes");
      expect(toolAny.escapeSQLString("it's")).toBe("it''s");
      expect(toolAny.escapeSQLString("no quotes")).toBe("no quotes");
    });

    it("should handle normal file paths safely", async () => {
      const db1Path = join(testDir, "test_db1.db");
      const db2Path = join(testDir, "test_db2.db");
      const outputPath = join(testDir, "output.db");

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      await expect(tool.merge(db1Path, db2Path, outputPath)).resolves.not.toThrow();
    });

    it("should reject file paths with semicolons", async () => {
      // Note: Files with semicolons in names cannot be created on many filesystems
      // We'll test the validation directly
      const db1Path = join(testDir, "test_semicolon.db");
      const db2Path = join(testDir, "normal.db");
      const maliciousOutputPath = join(testDir, "output;injection.db");

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      // The validation should catch the semicolon
      await expect(tool.merge(db1Path, db2Path, maliciousOutputPath))
        .rejects.toThrow("suspicious pattern");
    });
  });

  describe("Directory Traversal Prevention", () => {
    it("should reject paths with directory traversal patterns", async () => {
      const maliciousPath1 = "../../../etc/passwd";
      const normalPath = join(testDir, "normal.db");
      const outputPath = join(testDir, "output.db");

      await createMinimalDatabase(normalPath);

      await expect(tool.merge(maliciousPath1, normalPath, outputPath))
        .rejects.toThrow("File not found");
    });

    it("should reject paths with null bytes", async () => {
      const db1Path = join(testDir, "test.db");
      const db2Path = join(testDir, "normal.db"); 
      // Create path with null byte programmatically
      const outputPath = join(testDir, "output") + "\0" + ".db";

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      await expect(tool.merge(db1Path, db2Path, outputPath))
        .rejects.toThrow("null byte");
    });

    it("should reject paths with shell metacharacters", async () => {
      const patterns = ['|', '&', '>', '<', '`'];
      
      // Create databases once
      const db1Path = join(testDir, "normal1.db");
      const db2Path = join(testDir, "normal2.db");
      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);
      
      for (const pattern of patterns) {
        const outputPath = join(testDir, `output${pattern}test.db`);

        await expect(tool.merge(db1Path, db2Path, outputPath))
          .rejects.toThrow("suspicious pattern");
      }
    });
  });

  describe("File Size DoS Prevention", () => {
    it("should have a file size limit", async () => {
      // Access the private MAX_FILE_SIZE_MB through type assertion
      const toolAny = tool as any;
      expect(toolAny.MAX_FILE_SIZE_MB).toBeDefined();
      expect(toolAny.MAX_FILE_SIZE_MB).toBe(5000); // 5GB
    });

    it("should validate file sizes in the validation method", async () => {
      const db1Path = join(testDir, "test.db");
      const db2Path = join(testDir, "normal.db");

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      // The validation should check file sizes
      const toolAny = tool as any;
      expect(() => toolAny.validateDatabaseFile(db1Path)).not.toThrow();
    });
  });

  describe("Path Validation Edge Cases", () => {
    it("should handle absolute paths correctly", async () => {
      const db1Path = join(testDir, "test1.db");
      const db2Path = join(testDir, "test2.db");
      const outputPath = join(testDir, "output.db");

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      await expect(tool.merge(db1Path, db2Path, outputPath)).resolves.not.toThrow();
    });

    it("should reject paths with newlines", async () => {
      const db1Path = join(testDir, "test.db");
      const db2Path = join(testDir, "normal.db");
      // Create path with newline programmatically
      const maliciousPath = join(testDir, "test") + "\n" + "injection.db";

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      await expect(tool.merge(maliciousPath, db2Path, join(testDir, "output.db")))
        .rejects.toThrow("newline");
    });

    it("should reject paths with carriage returns", async () => {
      const db1Path = join(testDir, "test.db");
      const db2Path = join(testDir, "normal.db");
      // Create path with carriage return programmatically
      const maliciousPath = join(testDir, "test") + "\r" + "injection.db";

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      await expect(tool.merge(maliciousPath, db2Path, join(testDir, "output.db")))
        .rejects.toThrow("carriage return");
    });

    it("should normalize paths to prevent tricks", async () => {
      const db1Path = join(testDir, "./test1.db");
      const db2Path = join(testDir, "subdir/../test2.db");
      const outputPath = join(testDir, "output.db");

      await createMinimalDatabase(join(testDir, "test1.db"));
      await createMinimalDatabase(join(testDir, "test2.db"));

      // These should be normalized and work correctly
      await expect(tool.merge(db1Path, db2Path, outputPath)).resolves.not.toThrow();
    });
  });

  describe("Integration Security Tests", () => {
    it("should sanitize all three paths (source1, source2, output)", async () => {
      const db1Path = join(testDir, "db1.db");
      const db2Path = join(testDir, "db2.db");
      // Create malicious output path
      const outputPath = join(testDir, "output") + "|injection.db";

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      // Output path with shell metacharacter should be rejected
      await expect(tool.merge(db1Path, db2Path, outputPath))
        .rejects.toThrow("suspicious pattern");
    });

    it("should handle spaces in paths correctly", async () => {
      const db1Path = join(testDir, "test with spaces.db");
      const db2Path = join(testDir, "another file.db");
      const outputPath = join(testDir, "output file.db");

      await createMinimalDatabase(db1Path);
      await createMinimalDatabase(db2Path);

      // Spaces should be handled correctly
      await expect(tool.merge(db1Path, db2Path, outputPath)).resolves.not.toThrow();
    });
  });
});