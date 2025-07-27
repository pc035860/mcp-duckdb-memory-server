import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBMergeTool } from "../src/tools/merge-duckdb.js";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, rmSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { generateUniqueTempDir, cleanupTempDir, ensureDbFullyClosed } from "./test-utils.js";

describe("DuckDBMergeTool - Schema Validation and Migration", () => {
  let tool: DuckDBMergeTool;
  let tempDir: string;
  let db1Path: string;
  let db2Path: string;
  let outputPath: string;

  beforeEach(() => {
    tool = new DuckDBMergeTool();
    
    // Create temp directory for test databases
    tempDir = generateUniqueTempDir('merge-schema-test');
    db1Path = resolve(tempDir, "db1.db");
    db2Path = resolve(tempDir, "db2.db");
    outputPath = resolve(tempDir, "merged.db");
  });

  afterEach(async () => {
    // Ensure all databases are fully closed
    await ensureDbFullyClosed(db1Path);
    await ensureDbFullyClosed(db2Path);
    await ensureDbFullyClosed(outputPath);
    
    // Clean up test files
    await cleanupTempDir(tempDir);
  });

  it("should detect missing tables in source databases", async () => {
    // Create a proper first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    // Create a database with missing tables
    const instance = await DuckDBInstance.create(db2Path);
    const conn = await instance.connect();
    
    // Create only partial schema
    await conn.run(`
      CREATE TABLE entities (
        name VARCHAR PRIMARY KEY,
        entityType VARCHAR NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL
      )
    `);
    // Missing: observations and relations tables
    
    conn.close();
    // DuckDBInstance doesn't have close() method, connection close is sufficient

    // Try to merge - should fail due to invalid schema
    await expect(tool.merge(db1Path, db2Path, outputPath)).rejects.toThrow(/Invalid schema/);
  });

  it("should handle databases with extra columns gracefully", async () => {
    // Create first database with standard schema
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "TestEntity", entityType: "Type", observations: ["Obs1"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();
    await ensureDbFullyClosed(db1Path);

    // Create second database and add extra column
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "TestEntity2", entityType: "Type", observations: ["Obs2"], createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager2.close();
    await ensureDbFullyClosed(db2Path);
    
    // Add extra column to second database using a fresh connection
    const instance = await DuckDBInstance.create(db2Path);
    const conn = await instance.connect();
    
    try {
      // Add an extra column to the entities table
      await conn.run(`ALTER TABLE entities ADD COLUMN extra_data VARCHAR`);
      
      // Update existing record with extra data
      await conn.run(`UPDATE entities SET extra_data = 'additional info' WHERE name = 'testentity2'`);
    } finally {
      conn.close();
      await ensureDbFullyClosed(db2Path);
    }

    // Wait to ensure full cleanup
    await new Promise(resolve => setTimeout(resolve, 200));

    // Merge should handle the extra column gracefully
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database works correctly
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["TestEntity", "TestEntity2"]);
    expect(result.entities).toHaveLength(2);
    
    const entity1 = result.entities.find(e => e.name === "TestEntity")!;
    const entity2 = result.entities.find(e => e.name === "TestEntity2")!;
    
    expect(entity1).toBeDefined();
    expect(entity2).toBeDefined();
    expect(entity1.observations).toContain("Obs1");
    expect(entity2.observations).toContain("Obs2");
    
    await mergedManager.close();
  });

  it("should verify index consistency after merge", async () => {
    // Create databases with substantial data to test index performance
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    // Add many entities to test index
    const entities1 = [];
    for (let i = 0; i < 50; i++) {
      entities1.push({
        name: `IndexTest_${i}`,
        entityType: "TestType",
        observations: [`Observation ${i}`],
        createdAt: `2024-01-01T${String(i % 24).padStart(2, '0')}:00:00Z`
      });
    }
    await manager1.createEntities(entities1);
    
    await manager1.close();

    // Create second database
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    const entities2 = [];
    for (let i = 40; i < 90; i++) {
      entities2.push({
        name: `IndexTest_${i}`,
        entityType: "TestType",
        observations: [`Observation ${i} v2`],
        createdAt: `2024-02-01T${String(i % 24).padStart(2, '0')}:00:00Z`
      });
    }
    await manager2.createEntities(entities2);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify indexes work correctly by doing searches
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    // Test exact match (should use index)
    const exactResult = await mergedManager.openNodes(["IndexTest_25"]);
    expect(exactResult.entities).toHaveLength(1);
    
    // Test prefix search (should use index efficiently)
    const searchResult = await mergedManager.searchNodes("IndexTest_");
    expect(searchResult.entities.length).toBe(90); // 0-89
    
    await mergedManager.close();
  });

  it("should handle constraint violations during merge", async () => {
    // This tests that the merge properly handles potential constraint violations
    // For example, if both databases have the same entity-observation pair
    // but with different timestamps, the conflict resolution should work
    
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "ConstraintTest", entityType: "Type", observations: ["Shared Observation"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "ConstraintTest", entityType: "Type", observations: ["Shared Observation"], createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge should handle the duplicate observation constraint gracefully
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify the observation appears only once
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["ConstraintTest"]);
    expect(result.entities).toHaveLength(1);
    
    // Count occurrences of the observation
    const observations = result.entities[0].observations;
    const sharedObsCount = observations.filter(obs => obs === "Shared Observation").length;
    expect(sharedObsCount).toBe(1); // Should be deduplicated
    
    await mergedManager.close();
  });

  it("should preserve database integrity with foreign key constraints", async () => {
    // Test that relations referential integrity is maintained
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Parent1", entityType: "Parent", observations: ["Parent node"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Child1", entityType: "Child", observations: ["Child node"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "Parent1", to: "Child1", relationType: "has_child", createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with orphaned relation (entity doesn't exist in this DB)
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Parent2", entityType: "Parent", observations: ["Another parent"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Child1", entityType: "Child", observations: ["Same child, different obs"], createdAt: "2024-01-03T00:00:00Z" }
    ]);
    
    // This relation references Parent1 which doesn't exist in db2
    // But it should work after merge because Parent1 will exist in merged DB
    try {
      await manager2.createRelations([
        { from: "Parent1", to: "Parent2", relationType: "knows", createdAt: "2024-01-04T00:00:00Z" }
      ]);
    } catch (e) {
      // This might fail due to FK constraint, which is expected
    }
    
    await manager2.close();

    // Merge should maintain all valid relations
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify integrity
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["Parent1", "Parent2", "Child1"]);
    expect(allNodes.entities).toHaveLength(3);
    
    // Verify all relations are valid (no orphaned relations)
    for (const relation of allNodes.relations) {
      const fromExists = allNodes.entities.some(e => e.name === relation.from);
      const toExists = allNodes.entities.some(e => e.name === relation.to);
      expect(fromExists).toBe(true);
      expect(toExists).toBe(true);
    }
    
    await mergedManager.close();
  });

  it("should handle transaction rollback on error", async () => {
    // Create valid first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "ValidEntity", entityType: "Type", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "AnotherEntity", entityType: "Type", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Corrupt the second database by truncating it
    const instance = await DuckDBInstance.create(db2Path);
    const conn = await instance.connect();
    
    try {
      // This will make the merge fail during execution
      await conn.run("DROP TABLE observations");
    } catch (e) {
      // Ignore errors
    }
    
    conn.close();
    // DuckDBInstance doesn't have close() method, connection close is sufficient

    // Attempt merge - should fail and rollback
    await expect(tool.merge(db1Path, db2Path, outputPath)).rejects.toThrow();

    // Output file may exist but should be empty or minimal due to rollback
    // The file is created during initialization, but the transaction is rolled back
    // so the data is not persisted
    if (existsSync(outputPath)) {
      // If file exists, verify it's empty or has only schema
      const verifyManager = new DuckDBKnowledgeGraphManager(() => outputPath);
      await verifyManager.initialize();
      // Verify database is empty (rollback worked)
      const entities = await verifyManager.searchNodes("");
      expect(entities.entities).toHaveLength(0);
      await verifyManager.close();
    }
  });

  it("should handle timestamp precision correctly", async () => {
    // Test various timestamp formats and precisions
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "TimePrecision1", entityType: "Type", observations: ["Test"], createdAt: "2024-01-01T12:34:56.789Z" },
      { name: "TimePrecision2", entityType: "Type", observations: ["Test"], createdAt: "2024-01-01T12:34:56.000Z" },
      { name: "TimePrecision3", entityType: "Type", observations: ["Test"], createdAt: "2024-01-01T12:34:56Z" }
    ]);
    
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "TimePrecision1", entityType: "Type", observations: ["Test2"], createdAt: "2024-01-01T12:34:56.790Z" }, // 1ms later
      { name: "TimePrecision2", entityType: "Type", observations: ["Test2"], createdAt: "2024-01-01T12:34:56.001Z" }, // 1ms later
      { name: "TimePrecision3", entityType: "Type", observations: ["Test2"], createdAt: "2024-01-01T12:34:57Z" } // 1s later
    ]);
    
    await manager2.close();

    // Merge
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify timestamps are preserved correctly
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["TimePrecision1", "TimePrecision2", "TimePrecision3"]);
    
    const tp1 = result.entities.find(e => e.name === "TimePrecision1")!;
    const tp2 = result.entities.find(e => e.name === "TimePrecision2")!;
    const tp3 = result.entities.find(e => e.name === "TimePrecision3")!;
    
    // Should keep earlier timestamps
    expect(tp1.createdAt).toBe("2024-01-01T12:34:56.789Z");
    expect(tp2.createdAt).toBe("2024-01-01T12:34:56.000Z");
    expect(tp3.createdAt).toBe("2024-01-01T12:34:56.000Z"); // DuckDB normalizes missing milliseconds
    
    await mergedManager.close();
  });
});