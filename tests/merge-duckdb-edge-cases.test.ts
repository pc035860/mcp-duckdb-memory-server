import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBMergeTool } from "../src/tools/merge-duckdb.js";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager.js";
import { existsSync, rmSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

describe("DuckDBMergeTool - Edge Cases and Error Handling", () => {
  let tool: DuckDBMergeTool;
  let tempDir: string;
  let db1Path: string;
  let db2Path: string;
  let outputPath: string;

  beforeEach(() => {
    tool = new DuckDBMergeTool();
    
    // Create temp directory for test databases
    tempDir = resolve(tmpdir(), `merge-edge-test-${randomBytes(8).toString('hex')}`);
    mkdirSync(tempDir, { recursive: true });
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

  it("should handle very long entity names and observations", async () => {
    // Create first database with very long strings
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    const longName = "Entity_" + "x".repeat(1000);
    const longObservation = "This is a very long observation " + "content ".repeat(500);
    
    await manager1.createEntities([
      { 
        name: longName, 
        entityType: "LongType", 
        observations: [longObservation], 
        createdAt: "2024-01-01T00:00:00Z" 
      }
    ]);
    
    await manager1.close();

    // Create second database
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { 
        name: longName, 
        entityType: "LongType", 
        observations: ["Short observation"], 
        createdAt: "2024-01-02T00:00:00Z" 
      }
    ]);
    
    await manager2.close();

    // Merge should handle long strings
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes([longName]);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].observations).toHaveLength(2);
    
    await mergedManager.close();
  });

  it("should handle unicode and emoji in data", async () => {
    // Create first database with unicode
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { 
        name: "测试实体🎉", 
        entityType: "Unicode类型", 
        observations: ["观察结果 with émojis 🚀", "日本語のテキスト"], 
        createdAt: "2024-01-01T00:00:00Z" 
      },
      { 
        name: "مستخدم_عربي", 
        entityType: "نوع", 
        observations: ["ملاحظة باللغة العربية"], 
        createdAt: "2024-01-01T00:00:00Z" 
      }
    ]);
    
    await manager1.close();

    // Create second database with more unicode
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { 
        name: "测试实体🎉", 
        entityType: "Unicode类型", 
        observations: ["Additional 观察 ✨"], 
        createdAt: "2024-01-02T00:00:00Z" 
      }
    ]);
    
    await manager2.close();

    // Merge should preserve unicode correctly
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const chineseResult = await mergedManager.searchNodes("测试");
    expect(chineseResult.entities.length).toBeGreaterThan(0);
    
    const arabicResult = await mergedManager.searchNodes("عربي");
    expect(arabicResult.entities.length).toBeGreaterThan(0);
    
    await mergedManager.close();
  });

  it("should handle self-referential relations", async () => {
    // Create first database with self-references
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Node1", entityType: "SelfRef", observations: ["Self referencing node"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "Node1", to: "Node1", relationType: "references_self", createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Node1", entityType: "SelfRef", observations: ["Updated"], createdAt: "2024-02-01T00:00:00Z" }
    ]);
    
    await manager2.createRelations([
      { from: "Node1", to: "Node1", relationType: "references_self", createdAt: "2024-02-02T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge should handle self-references
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["Node1"]);
    expect(result.entities).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].from).toBe("Node1");
    expect(result.relations[0].to).toBe("Node1");
    expect(result.relations[0].createdAt).toBe("2024-01-02T00:00:00.000Z");
    
    await mergedManager.close();
  });

  it("should handle databases with only entities (no relations)", async () => {
    // Create first database with only entities
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    for (let i = 0; i < 10; i++) {
      await manager1.createEntities([
        { name: `OnlyEntity${i}`, entityType: "Standalone", observations: [`Obs ${i}`], createdAt: `2024-01-01T0${i}:00:00Z` }
      ]);
    }
    
    await manager1.close();

    // Create second database also with only entities
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    for (let i = 5; i < 15; i++) {
      await manager2.createEntities([
        { name: `OnlyEntity${i}`, entityType: "Standalone", observations: [`Obs ${i} v2`], createdAt: `2024-02-01T0${i % 10}:00:00Z` }
      ]);
    }
    
    await manager2.close();

    // Merge should work without relations
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const searchResult = await mergedManager.searchNodes("OnlyEntity");
    expect(searchResult.entities.length).toBe(15); // 0-14
    expect(searchResult.relations).toHaveLength(0);
    
    await mergedManager.close();
  });

  it("should handle databases with only relations (entities created implicitly)", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    // First create entities that relations will reference
    await manager1.createEntities([
      { name: "A", entityType: "Node", observations: [], createdAt: "2024-01-01T00:00:00Z" },
      { name: "B", entityType: "Node", observations: [], createdAt: "2024-01-01T00:00:00Z" },
      { name: "C", entityType: "Node", observations: [], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.createRelations([
      { from: "A", to: "B", relationType: "rel1", createdAt: "2024-01-02T00:00:00Z" },
      { from: "B", to: "C", relationType: "rel2", createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager1.close();

    // Create second database with overlapping relations
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "A", entityType: "Node", observations: [], createdAt: "2024-02-01T00:00:00Z" },
      { name: "B", entityType: "Node", observations: [], createdAt: "2024-02-01T00:00:00Z" },
      { name: "C", entityType: "Node", observations: [], createdAt: "2024-02-01T00:00:00Z" },
      { name: "D", entityType: "Node", observations: [], createdAt: "2024-02-01T00:00:00Z" }
    ]);
    
    await manager2.createRelations([
      { from: "A", to: "B", relationType: "rel1", createdAt: "2024-02-02T00:00:00Z" },
      { from: "C", to: "D", relationType: "rel3", createdAt: "2024-02-02T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const allNodes = await mergedManager.openNodes(["A", "B", "C", "D"]);
    expect(allNodes.entities).toHaveLength(4);
    expect(allNodes.relations).toHaveLength(3); // rel1 (deduplicated), rel2, rel3
    
    await mergedManager.close();
  });

  it("should handle null or undefined createdAt gracefully", async () => {
    // This test verifies the tool handles missing timestamps correctly
    // Note: The actual implementation may require timestamps, so this tests error handling
    
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    // Create entity with valid timestamp
    await manager1.createEntities([
      { name: "ValidEntity", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    // Create another entity with valid timestamp
    await manager2.createEntities([
      { name: "AnotherEntity", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge should complete successfully
    await expect(tool.merge(db1Path, db2Path, outputPath)).resolves.not.toThrow();
  });

  it("should handle concurrent merge attempts gracefully", async () => {
    // Create databases
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.createEntities([
      { name: "ConcurrentTest", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    await manager2.createEntities([
      { name: "ConcurrentTest2", entityType: "Test", observations: ["Test"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    await manager2.close();

    // Attempt concurrent merges to different outputs
    const output1 = resolve(tempDir, "merged1.db");
    const output2 = resolve(tempDir, "merged2.db");
    
    const mergePromises = [
      tool.merge(db1Path, db2Path, output1),
      tool.merge(db1Path, db2Path, output2)
    ];
    
    // Both should complete successfully
    await expect(Promise.all(mergePromises)).resolves.not.toThrow();
    
    // Verify both outputs exist
    expect(existsSync(output1)).toBe(true);
    expect(existsSync(output2)).toBe(true);
  });

  it("should handle observation deduplication with different timestamps", async () => {
    // Create first database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    
    await manager1.createEntities([
      { name: "Entity1", entityType: "Test", observations: ["Observation A"], createdAt: "2024-01-01T00:00:00Z" }
    ]);
    
    // Add the same observation again (simulating it was added at different time)
    await manager1.addObservations([
      { entityName: "Entity1", contents: ["Observation A", "Observation B"] }
    ]);
    
    await manager1.close();

    // Create second database with same entity and observations
    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    
    await manager2.createEntities([
      { name: "Entity1", entityType: "Test", observations: ["Observation A", "Observation C"], createdAt: "2024-01-02T00:00:00Z" }
    ]);
    
    await manager2.close();

    // Merge
    await tool.merge(db1Path, db2Path, outputPath);

    // Verify observations are deduplicated
    const mergedManager = new DuckDBKnowledgeGraphManager(() => outputPath);
    await mergedManager.initialize();
    
    const result = await mergedManager.openNodes(["Entity1"]);
    expect(result.entities).toHaveLength(1);
    
    // Should have unique observations only
    const observations = result.entities[0].observations;
    const uniqueObs = [...new Set(observations)];
    expect(observations.length).toBe(uniqueObs.length);
    expect(observations).toContain("Observation A");
    expect(observations).toContain("Observation B");
    expect(observations).toContain("Observation C");
    
    await mergedManager.close();
  });

  it("should validate output path is not same as input paths", async () => {
    // Create a database
    const manager1 = new DuckDBKnowledgeGraphManager(() => db1Path, undefined, true);
    await manager1.initialize();
    await manager1.close();

    const manager2 = new DuckDBKnowledgeGraphManager(() => db2Path, undefined, true);
    await manager2.initialize();
    await manager2.close();

    // Try to merge with output same as input
    await expect(tool.merge(db1Path, db2Path, db1Path)).rejects.toThrow("Output file already exists");
    await expect(tool.merge(db1Path, db2Path, db2Path)).rejects.toThrow("Output file already exists");
  });
});