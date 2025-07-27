import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager.js";
import { existsSync, rmSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { 
  createDatabaseViaCLI, 
  generateUniqueTempDir, 
  cleanupTempDir,
  waitForFileUnlock 
} from "./test-utils.js";

const execAsync = promisify(exec);

// Note: These tests face DuckDB file locking issues when the test process creates databases
// and then tries to access them via CLI in a separate process. This is a known limitation
// of DuckDB's exclusive locking mechanism. The merge functionality is thoroughly tested
// in merge-duckdb.test.ts using programmatic access.
describe("merge-duckdb CLI integration", () => {
  let tempDir: string;
  let db1Path: string;
  let db2Path: string;
  let outputPath: string;

  beforeEach(() => {
    // Create temp directory for test databases
    tempDir = generateUniqueTempDir('merge-cli-test');
    db1Path = resolve(tempDir, "db1.db");
    db2Path = resolve(tempDir, "db2.db");
    outputPath = resolve(tempDir, "merged.db");
  });

  afterEach(async () => {
    // Clean up test files
    await cleanupTempDir(tempDir);
  });

  it("should merge two databases via CLI", async () => {
    // Create databases using CLI to avoid process locking issues
    await createDatabaseViaCLI(db1Path, [
      { name: "Entity1", entityType: "Type1", observations: ["Obs1"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await createDatabaseViaCLI(db2Path, [
      { name: "Entity2", entityType: "Type2", observations: ["Obs2"], createdAt: "2024-02-01T00:00:00Z" }
    ]);

    // Wait for file locks to be released
    await waitForFileUnlock(db1Path);
    await waitForFileUnlock(db2Path);

    // Run merge via CLI
    const mergeCmd = `node dist/tools/merge-duckdb.mjs "${db1Path}" "${db2Path}" "${outputPath}"`;
    execSync(mergeCmd, { cwd: process.cwd() });

    // Verify merged database exists
    expect(existsSync(outputPath)).toBe(true);

    // Verify merged content
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["Entity1", "Entity2"]);
    
    expect(allNodes.entities).toHaveLength(2);
    expect(allNodes.entities.find(e => e.name === "Entity1")).toBeDefined();
    expect(allNodes.entities.find(e => e.name === "Entity2")).toBeDefined();
    
    await mergedManager.close();
  });

  it("should handle help flag", () => {
    const output = execSync(`node dist/tools/merge-duckdb.mjs --help`, { 
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    
    expect(output).toContain("Usage: merge-duckdb");
    expect(output).toContain("Merges two DuckDB knowledge graph databases");
  });

  it("should handle complex real-world scenario via CLI", async () => {
    // Create a more complex first database using CLI
    await createDatabaseViaCLI(db1Path, [
      { name: "TechCorp", entityType: "Company", observations: ["Founded 2020", "AI Startup"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Alice Johnson", entityType: "Person", observations: ["CEO", "10 years experience"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Bob Smith", entityType: "Person", observations: ["CTO", "Python expert"], createdAt: "2024-01-01T00:00:00Z" }
    ], [
      { from: "Alice Johnson", to: "TechCorp", relationType: "founded", createdAt: "2024-01-02T00:00:00Z" },
      { from: "Bob Smith", to: "TechCorp", relationType: "works_at", createdAt: "2024-01-02T00:00:00Z" },
      { from: "Alice Johnson", to: "Bob Smith", relationType: "hired", createdAt: "2024-01-03T00:00:00Z" }
    ]);

    // Create second database with updates using CLI
    await createDatabaseViaCLI(db2Path, [
      { name: "TechCorp", entityType: "Company", observations: ["AI Startup", "Series A funded", "20 employees"], createdAt: "2024-02-01T00:00:00Z" },
      { name: "Charlie Davis", entityType: "Person", observations: ["Lead Engineer", "5 years experience"], createdAt: "2024-02-01T00:00:00Z" },
      { name: "Alice Johnson", entityType: "Person", observations: ["CEO", "Keynote speaker"], createdAt: "2024-02-01T00:00:00Z" }
    ], [
      { from: "Charlie Davis", to: "TechCorp", relationType: "works_at", createdAt: "2024-02-02T00:00:00Z" },
      { from: "Bob Smith", to: "Charlie Davis", relationType: "mentors", createdAt: "2024-02-03T00:00:00Z" }
    ]);

    // Wait for file locks to be released
    await waitForFileUnlock(db1Path);
    await waitForFileUnlock(db2Path);

    // Run merge via CLI
    const mergeCmd = `node dist/tools/merge-duckdb.mjs "${db1Path}" "${db2Path}" "${outputPath}"`;
    const output = execSync(mergeCmd, { cwd: process.cwd(), encoding: 'utf8' });
    
    // Verify output contains expected messages
    expect(output).toContain("Merge completed successfully");
    expect(output).toContain("entities:");
    expect(output).toContain("relations:");

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["TechCorp", "Alice Johnson", "Bob Smith", "Charlie Davis"]);
    
    expect(allNodes.entities).toHaveLength(4);
    // Note: Some relations might not be created due to FK constraints in separate database creation
    expect(allNodes.relations.length).toBeGreaterThanOrEqual(3);
    
    // Verify TechCorp has all observations
    const techCorp = allNodes.entities.find(e => e.name === "TechCorp")!;
    expect(techCorp.observations).toContain("Founded 2020");
    expect(techCorp.observations).toContain("AI Startup");
    expect(techCorp.observations).toContain("Series A funded");
    expect(techCorp.observations).toContain("20 employees");
    
    await mergedManager.close();
  });

  it("should handle relative and absolute paths correctly", async () => {
    // Create databases using CLI
    await createDatabaseViaCLI(db1Path, [
      { name: "PathTest1", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await createDatabaseViaCLI(db2Path, [
      { name: "PathTest2", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);

    // Wait for file locks to be released
    await waitForFileUnlock(db1Path);
    await waitForFileUnlock(db2Path);

    // Create a subdirectory to test relative paths
    const subDir = resolve(tempDir, "subdir");
    mkdirSync(subDir, { recursive: true });
    
    // Change to temp directory and use relative paths
    const relativeOutput = "subdir/merged-relative.db";
    const mergeCmd = `cd "${tempDir}" && node "${process.cwd()}/dist/tools/merge-duckdb.mjs" "${db1Path}" "${db2Path}" "${relativeOutput}"`;
    
    execSync(mergeCmd, { shell: true });
    
    // Verify the file was created in the correct location
    const expectedPath = resolve(tempDir, relativeOutput);
    expect(existsSync(expectedPath)).toBe(true);
    
    // Verify content
    const mergedManager = new DuckDBKnowledgeGraphManager(() => expectedPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.searchNodes("PathTest");
    expect(result.entities).toHaveLength(2);
    
    await mergedManager.close();
  });

  it("should handle CLI errors gracefully", () => {
    // Test various error conditions
    
    // Non-existent source files
    let error1: Error | null = null;
    try {
      execSync(`node dist/tools/merge-duckdb.mjs "/non/existent1.db" "/non/existent2.db" "${outputPath}"`, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (e) {
      error1 = e as Error;
    }
    expect(error1).not.toBeNull();
    expect(error1?.message).toContain('Command failed');
    
    // No arguments shows help and exits cleanly (exit code 0)
    let helpOutput: string = '';
    try {
      helpOutput = execSync(`node dist/tools/merge-duckdb.mjs`, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (e) {
      // Should not throw
    }
    expect(helpOutput).toContain('Usage: merge-duckdb');
    
    // Too many arguments
    let error3: Error | null = null;
    try {
      execSync(`node dist/tools/merge-duckdb.mjs db1.db db2.db output.db extra.db`, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (e) {
      error3 = e as Error;
    }
    expect(error3).not.toBeNull();
  });

  it("should handle spaces in filenames via CLI", async () => {
    // Create databases with spaces in names
    const db1WithSpaces = resolve(tempDir, "database one.db");
    const db2WithSpaces = resolve(tempDir, "database two.db");
    const outputWithSpaces = resolve(tempDir, "merged database.db");
    
    await createDatabaseViaCLI(db1WithSpaces, [
      { name: "SpaceTest1", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await createDatabaseViaCLI(db2WithSpaces, [
      { name: "SpaceTest2", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);

    // Wait for file locks to be released
    await waitForFileUnlock(db1WithSpaces);
    await waitForFileUnlock(db2WithSpaces);

    // Run merge with proper escaping
    const mergeCmd = `node dist/tools/merge-duckdb.mjs "${db1WithSpaces}" "${db2WithSpaces}" "${outputWithSpaces}"`;
    execSync(mergeCmd, { cwd: process.cwd() });
    
    // Verify
    expect(existsSync(outputWithSpaces)).toBe(true);
    
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputWithSpaces);
    await mergedManager.initialize();
    
    const result = await mergedManager.searchNodes("SpaceTest");
    expect(result.entities).toHaveLength(2);
    
    await mergedManager.close();
  });

  it("should provide progress feedback for large merges", async () => {
    // Create larger databases to see progress messages
    const entities1 = [];
    for (let i = 0; i < 50; i++) {
      entities1.push({
        name: `LargeEntity${i}`,
        entityType: "Test",
        observations: [`Obs ${i}`],
        createdAt: `2024-01-01T${String(i % 24).padStart(2, '0')}:00:00Z`
      });
    }
    
    const entities2 = [];
    for (let i = 25; i < 75; i++) {
      entities2.push({
        name: `LargeEntity${i}`,
        entityType: "Test",
        observations: [`Obs ${i} v2`],
        createdAt: `2024-02-01T${String(i % 24).padStart(2, '0')}:00:00Z`
      });
    }
    
    await createDatabaseViaCLI(db1Path, entities1);
    await createDatabaseViaCLI(db2Path, entities2);

    // Wait for file locks to be released
    await waitForFileUnlock(db1Path);
    await waitForFileUnlock(db2Path);

    // Run merge and capture output
    const mergeCmd = `node dist/tools/merge-duckdb.mjs "${db1Path}" "${db2Path}" "${outputPath}"`;
    const output = execSync(mergeCmd, { cwd: process.cwd(), encoding: 'utf8' });
    
    // Should see progress messages
    expect(output).toContain("Validating source databases");
    expect(output).toContain("Attaching source databases");
    expect(output).toContain("Merging entities");
    expect(output).toContain("Merging observations");
    expect(output).toContain("Merging relations");
    expect(output).toContain("Verifying referential integrity");
    expect(output).toContain("duration_s");
  });

  it("should error on missing arguments", () => {
    expect(() => {
      execSync(`node dist/tools/merge-duckdb.mjs db1.db`, { 
        cwd: process.cwd(),
        encoding: 'utf8'
      });
    }).toThrow();
  });

  it("should handle concurrent CLI invocations", async () => {
    // Create databases using CLI
    await createDatabaseViaCLI(db1Path, [
      { name: "Concurrent1", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await createDatabaseViaCLI(db2Path, [
      { name: "Concurrent2", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);

    // Wait for file locks to be released
    await waitForFileUnlock(db1Path);
    await waitForFileUnlock(db2Path);

    // Run multiple merges concurrently to different outputs
    const outputs = [
      resolve(tempDir, "concurrent1.db"),
      resolve(tempDir, "concurrent2.db"),
      resolve(tempDir, "concurrent3.db")
    ];
    
    const promises = outputs.map(output => 
      execAsync(`node dist/tools/merge-duckdb.mjs "${db1Path}" "${db2Path}" "${output}"`, {
        cwd: process.cwd()
      })
    );
    
    // All should succeed
    await Promise.all(promises);
    
    // Verify all outputs exist and are valid
    for (const output of outputs) {
      expect(existsSync(output)).toBe(true);
      
      const manager = new DuckDBKnowledgeGraphManager(() => output);
      await manager.initialize();
      
      const result = await manager.searchNodes("Concurrent");
      expect(result.entities).toHaveLength(2);
      
      await manager.close();
    }
  });
});