import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBMergeTool } from "../src/tools/merge-duckdb.js";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager.js";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { DuckDBInstance } from "@duckdb/node-api";

describe("DuckDBMergeTool - Comprehensive Tests", () => {
  let tool: DuckDBMergeTool;
  let tempDir: string;
  let db1Path: string;
  let db2Path: string;
  let outputPath: string;

  beforeEach(() => {
    tool = new DuckDBMergeTool();
    
    // Create temp directory for test databases
    tempDir = resolve(tmpdir(), `merge-test-${randomBytes(8).toString('hex')}`);
    db1Path = resolve(tempDir, "db1.db");
    db2Path = resolve(tempDir, "db2.db");
    outputPath = resolve(tempDir, "merged.db");
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should merge two databases with non-overlapping data", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Alice", entityType: "Person", observations: ["Works at Acme Corp"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Bob", entityType: "Person", observations: ["Lives in NYC"], createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "Alice", to: "Bob", relationType: "knows", createdAt: "2024-01-03T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Charlie", entityType: "Person", observations: ["Likes coffee"], createdAt: "2024-02-01T00:00:00Z" },
      { name: "David", entityType: "Person", observations: ["Plays guitar"], createdAt: "2024-02-02T00:00:00Z" }
    ]);
    
    await manager2.createRelations([
      { from: "Charlie", to: "David", relationType: "knows", createdAt: "2024-02-03T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["Alice", "Bob", "Charlie", "David"]);
    
    expect(allNodes.entities).toHaveLength(4);
    expect(allNodes.relations).toHaveLength(2);
    
    await mergedManager.close();
  });

  it("should handle overlapping entities by keeping earliest created_at", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Alice", entityType: "Person", observations: ["Observation 1"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with same entity but later timestamp
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Alice", entityType: "User", observations: ["Observation 2"], createdAt: "2024-02-01T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["Alice"]);
    
    expect(result.entities).toHaveLength(1);
    const alice = result.entities[0];
    expect(alice.entityType).toBe("User"); // Should keep the newer entity type
    expect(alice.createdAt).toBe("2024-01-01T00:00:00.000Z"); // Should keep earliest created_at
    expect(alice.observations).toContain("Observation 1");
    expect(alice.observations).toContain("Observation 2");
    
    await mergedManager.close();
  });

  it("should union observations for same entity", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Alice", entityType: "Person", observations: ["Obs1", "Obs2"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with same entity and some overlapping observations
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Alice", entityType: "Person", observations: ["Obs2", "Obs3"], createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["Alice"]);
    
    expect(result.entities).toHaveLength(1);
    const alice = result.entities[0];
    expect(alice.observations).toHaveLength(3);
    expect(alice.observations).toContain("Obs1");
    expect(alice.observations).toContain("Obs2");
    expect(alice.observations).toContain("Obs3");
    
    await mergedManager.close();
  });

  it("should handle overlapping relations by keeping earliest created_at", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Alice", entityType: "Person", observations: [], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Bob", entityType: "Person", observations: [], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "Alice", to: "Bob", relationType: "knows", createdAt: "2024-01-05T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with same relation but different timestamp
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Alice", entityType: "Person", observations: [], createdAt: "2024-01-02T00:00:00Z" },
      { name: "Bob", entityType: "Person", observations: [], createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager2.createRelations([
      { from: "Alice", to: "Bob", relationType: "knows", createdAt: "2024-01-10T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["Alice", "Bob"]);
    
    expect(result.relations).toHaveLength(1);
    const relation = result.relations[0];
    expect(relation.createdAt).toBe("2024-01-05T00:00:00.000Z"); // Should keep earliest
    
    await mergedManager.close();
  });

  it("should reject invalid database files", async () => {
    // Create a non-database file
    const invalidPath = resolve(tempDir, "invalid.txt");
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    await expect(tool.merge(db1Path, invalidPath, outputPath)).rejects.toThrow("File not found");
  });

  it("should handle complex merge with multiple overlapping entities and relations", async () => {
    // Create first database with complex data
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Alice", entityType: "Person", observations: ["Manager at TechCo", "Lives in SF"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Bob", entityType: "Person", observations: ["Engineer", "Python expert"], createdAt: "2024-01-02T00:00:00Z" },
      { name: "TechCo", entityType: "Company", observations: ["Founded 2020", "AI Startup"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "Alice", to: "TechCo", relationType: "works_at", createdAt: "2024-01-05T00:00:00Z" },
      { from: "Bob", to: "TechCo", relationType: "works_at", createdAt: "2024-01-06T00:00:00Z" },
      { from: "Alice", to: "Bob", relationType: "manages", createdAt: "2024-01-07T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with overlapping and new data
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Alice", entityType: "Person", observations: ["Manager at TechCo", "MBA from Stanford", "Speaks 3 languages"], createdAt: "2024-02-01T00:00:00Z" },
      { name: "Charlie", entityType: "Person", observations: ["Designer", "UX Specialist"], createdAt: "2024-02-02T00:00:00Z" },
      { name: "TechCo", entityType: "Company", observations: ["AI Startup", "50 employees", "Series A funded"], createdAt: "2024-02-01T00:00:00Z" }
    ]);
    
    await manager2.createRelations([
      { from: "Charlie", to: "TechCo", relationType: "works_at", createdAt: "2024-02-05T00:00:00Z" },
      { from: "Alice", to: "Charlie", relationType: "manages", createdAt: "2024-02-06T00:00:00Z" },
      { from: "Alice", to: "Bob", relationType: "manages", createdAt: "2024-02-07T00:00:00Z" } // Duplicate with different timestamp
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["Alice", "Bob", "Charlie", "TechCo"]);
    
    // Check entities
    expect(allNodes.entities).toHaveLength(4);
    
    const alice = allNodes.entities.find(e => e.name === "Alice")!;
    expect(alice.createdAt).toBe("2024-01-01T00:00:00.000Z"); // Earlier timestamp
    expect(alice.observations).toHaveLength(4); // Union of all unique observations
    expect(alice.observations).toContain("Manager at TechCo");
    expect(alice.observations).toContain("Lives in SF");
    expect(alice.observations).toContain("MBA from Stanford");
    expect(alice.observations).toContain("Speaks 3 languages");
    
    const techCo = allNodes.entities.find(e => e.name === "TechCo")!;
    expect(techCo.observations).toHaveLength(4); // All unique observations
    
    // Check relations
    expect(allNodes.relations).toHaveLength(5); // All unique relations
    
    const aliceBobManages = allNodes.relations.find(r => 
      r.from === "Alice" && r.to === "Bob" && r.relationType === "manages"
    )!;
    expect(aliceBobManages.createdAt).toBe("2024-01-07T00:00:00.000Z"); // Earlier timestamp
    
    await mergedManager.close();
  });

  it("should handle empty databases", async () => {
    // Create empty first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    // Create second database with data
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Entity1", entityType: "Type1", observations: ["Obs1"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["Entity1"]);
    expect(allNodes.entities).toHaveLength(1);
    
    await mergedManager.close();
  });

  it("should handle both databases being empty", async () => {
    // Create two empty databases
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify merged database is empty but valid
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const searchResult = await mergedManager.searchNodes("anything");
    expect(searchResult.entities).toHaveLength(0);
    expect(searchResult.relations).toHaveLength(0);
    
    await mergedManager.close();
  });

  it("should handle large datasets efficiently", async () => {
    // Create first database with many entities
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    const entities1 = [];
    for (let i = 0; i < 100; i++) {
      entities1.push({
        name: `Entity_${i}`,
        entityType: "TestType",
        observations: [`Observation for entity ${i}`],
        createdAt: `2024-01-01T${String(i % 24).padStart(2, '0')}:00:00Z`
      });
    }
    await manager1.createEntities(entities1);
    
    // Create relations
    const relations1 = [];
    for (let i = 0; i < 50; i++) {
      relations1.push({
        from: `Entity_${i}`,
        to: `Entity_${i + 50}`,
        relationType: "related_to",
        createdAt: `2024-01-02T${String(i % 24).padStart(2, '0')}:00:00Z`
      });
    }
    await manager1.createRelations(relations1);
    
    await manager1.close();

    // Create second database with overlapping and new entities
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    const entities2 = [];
    for (let i = 50; i < 150; i++) {
      entities2.push({
        name: `Entity_${i}`,
        entityType: "TestType",
        observations: [`Different observation for entity ${i}`],
        createdAt: `2024-02-01T${String(i % 24).padStart(2, '0')}:00:00Z`
      });
    }
    await manager2.createEntities(entities2);
    
    await manager2.close();

    // Measure merge time
    const startTime = Date.now();
    await tool.merge(db1Path, db2Path, outputPath);
    const mergeTime = Date.now() - startTime;
    
    // Should complete reasonably fast (under 5 seconds for this dataset)
    expect(mergeTime).toBeLessThan(5000);

    // Verify merged database
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    // Count total entities
    const countResult = await mergedManager.searchNodes("Entity_");
    expect(countResult.entities.length).toBeGreaterThanOrEqual(150); // All unique entities
    
    await mergedManager.close();
  });

  it("should reject if output file already exists", async () => {
    // Create databases
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    await manager2.close();

    // Create output file
    const managerOut = new DuckDBKnowledgeGraphManager(() => outputPath);
    await managerOut.initialize();
    await managerOut.close();

    // Try to merge to existing file
    await expect(tool.merge(db1Path, db2Path, outputPath)).rejects.toThrow("Output file already exists");
  });

  it("should handle corrupted or invalid database files", async () => {
    // Create a valid first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    // Create an invalid second "database" (just a text file)
    mkdirSync(dirname(db2Path), { recursive: true });
    writeFileSync(db2Path, "This is not a valid DuckDB file");

    // Try to merge - should fail during schema validation
    await expect(tool.merge(db1Path, db2Path, outputPath)).rejects.toThrow();
  });

  it("should handle file permission errors gracefully", async () => {
    // Create databases
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    await manager2.close();

    // Create output directory without write permissions (skip on Windows)
    if (process.platform !== 'win32') {
      const readOnlyDir = resolve(tempDir, "readonly");
      mkdirSync(readOnlyDir, { mode: 0o444 });
      const readOnlyOutput = resolve(readOnlyDir, "output.db");
      
      await expect(tool.merge(db1Path, db2Path, readOnlyOutput)).rejects.toThrow();
    }
  });

  it("should preserve exact timestamps including milliseconds", async () => {
    // Create first database with precise timestamps
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    const preciseTime1 = "2024-01-15T14:30:45.123Z";
    await manager1.createEntities([
      { name: "PreciseEntity", entityType: "Test", observations: ["Test"], createdAt: preciseTime1 }
    ]);
    
    await manager1.close();

    // Create second database
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    const preciseTime2 = "2024-01-15T14:30:45.456Z"; // Different milliseconds
    await manager2.createEntities([
      { name: "PreciseEntity", entityType: "Test", observations: ["Test2"], createdAt: preciseTime2 }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify exact timestamp preservation
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["PreciseEntity"]);
    expect(result.entities[0].createdAt).toBe(preciseTime1); // Should keep earlier timestamp with exact milliseconds
    
    await mergedManager.close();
  });

  it("should handle special characters in entity names", async () => {
    // Create first database with special characters
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Entity with 'quotes'", entityType: "Test", observations: ["Test 1"], createdAt: "2024-01-01T00:00:00Z" },
      { name: 'Entity with "double quotes"', entityType: "Test", observations: ["Test 2"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Entity\nwith\nnewlines", entityType: "Test", observations: ["Test 3"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "Entity\twith\ttabs", entityType: "Test", observations: ["Test 4"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Normal Entity", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge should handle special characters correctly
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const searchResult = await mergedManager.searchNodes("Entity");
    expect(searchResult.entities).toHaveLength(5);
    
    await mergedManager.close();
  });

  it("should maintain referential integrity after merge", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "A", entityType: "Node", observations: ["Node A"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "B", entityType: "Node", observations: ["Node B"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "A", to: "B", relationType: "connects", createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with partial overlap
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "B", entityType: "Node", observations: ["Node B updated"], createdAt: "2024-01-03T00:00:00Z" },
      { name: "C", entityType: "Node", observations: ["Node C"], createdAt: "2024-01-03T00:00:00Z" }
    ]);
    
    await manager2.createRelations([
      { from: "B", to: "C", relationType: "connects", createdAt: "2024-01-04T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify referential integrity
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["A", "B", "C"]);
    
    // All entities should exist
    expect(allNodes.entities).toHaveLength(3);
    
    // All relations should be valid
    expect(allNodes.relations).toHaveLength(2);
    
    // Check specific relations
    const abRelation = allNodes.relations.find(r => r.from === "A" && r.to === "B");
    expect(abRelation).toBeDefined();
    
    const bcRelation = allNodes.relations.find(r => r.from === "B" && r.to === "C");
    expect(bcRelation).toBeDefined();
    
    await mergedManager.close();
  });

  it("should handle case sensitivity correctly", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "TestEntity", entityType: "Type", observations: ["Original"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with different case
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "testentity", entityType: "Type", observations: ["Lowercase"], createdAt: "2024-01-02T00:00:00Z" },
      { name: "TESTENTITY", entityType: "Type", observations: ["Uppercase"], createdAt: "2024-01-03T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge databases
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify case handling
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    // DuckDB is case-sensitive, so we'll have 3 different entities
    const result = await mergedManager.openNodes(["TestEntity", "testentity", "TESTENTITY"]);
    expect(result.entities).toHaveLength(3);
    // Each entity should have 1 observation
    expect(result.entities.reduce((sum, e) => sum + e.observations.length, 0)).toBe(3);
    
    await mergedManager.close();
  });

  it("should handle circular relations correctly", async () => {
    // Create first database with circular relations
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "A", entityType: "Node", observations: ["A"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "B", entityType: "Node", observations: ["B"], createdAt: "2024-01-01T00:00:00Z" },
      { name: "C", entityType: "Node", observations: ["C"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "A", to: "B", relationType: "links", createdAt: "2024-01-02T00:00:00Z" },
      { from: "B", to: "C", relationType: "links", createdAt: "2024-01-02T00:00:00Z" },
      { from: "C", to: "A", relationType: "links", createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with same circular structure but different timestamps
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "A", entityType: "Node", observations: ["A2"], createdAt: "2024-02-01T00:00:00Z" },
      { name: "B", entityType: "Node", observations: ["B2"], createdAt: "2024-02-01T00:00:00Z" },
      { name: "C", entityType: "Node", observations: ["C2"], createdAt: "2024-02-01T00:00:00Z" }
    ]);
    
    await manager2.createRelations([
      { from: "A", to: "B", relationType: "links", createdAt: "2024-02-02T00:00:00Z" },
      { from: "B", to: "C", relationType: "links", createdAt: "2024-02-02T00:00:00Z" },
      { from: "C", to: "A", relationType: "links", createdAt: "2024-02-02T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge should handle circular relations without issues
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["A", "B", "C"]);
    
    expect(allNodes.entities).toHaveLength(3);
    expect(allNodes.relations).toHaveLength(3); // Should keep only one copy of each relation
    
    // All relations should have earlier timestamps
    allNodes.relations.forEach(rel => {
      expect(rel.createdAt).toBe("2024-01-02T00:00:00.000Z");
    });
    
    await mergedManager.close();
  });
});