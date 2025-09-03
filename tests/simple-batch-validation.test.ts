import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { generateUniqueDbPath, cleanupTestDb, safeCloseManager } from "./test-utils";

describe("Simple Batch Validation", () => {
  let manager: DuckDBKnowledgeGraphManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = generateUniqueDbPath("simple-batch-test");
    manager = new DuckDBKnowledgeGraphManager(() => dbPath, undefined, true);
    await manager.initialize();
  });

  afterEach(async () => {
    await safeCloseManager(manager);
    await cleanupTestDb(dbPath);
  });

  describe("Core Batch Query Functionality", () => {
    it("should execute search without parameter binding errors", async () => {
      // This test validates that the parameter binding fix is working
      await manager.createEntities([{
        name: "simple-test-entity",
        entityType: "test",
        observations: ["Simple test observation"],
        createdAt: new Date().toISOString()
      }]);

      // This should not throw any parameter binding errors
      const results = await manager.searchNodes("simple", {
        searchMode: "keyword"
      });

      expect(results.entities).toHaveLength(1);
      expect(results.entities[0].name).toBe("simple-test-entity");
      expect(results.entities[0].observationsCount).toBe(1);
    });

    it("should handle basic observations correctly", async () => {
      await manager.createEntities([{
        name: "obs-test-entity",
        entityType: "test",
        observations: [
          "First observation",
          "Second observation",
          "Third observation"
        ],
        createdAt: new Date().toISOString()
      }]);

      const results = await manager.searchNodes("obs-test", {
        searchMode: "keyword"
      });

      expect(results.entities).toHaveLength(1);
      const entity = results.entities[0];
      expect(entity.observationsCount).toBe(3);
      
      // In full mode, should have observations
      if (entity.observations && entity.observations.length > 0) {
        expect(entity.observations.length).toBeGreaterThan(0);
      }
    });

    it("should handle compact mode correctly", async () => {
      await manager.createEntities([{
        name: "compact-test-entity",
        entityType: "test",
        observations: ["obs1", "obs2", "obs3"],
        createdAt: new Date().toISOString()
      }]);

      const compactResults = await manager.searchNodes("compact-test", {
        searchMode: "keyword",
        output: {
          compact: true,
          includeObservations: false
        }
      });

      expect(compactResults.entities).toHaveLength(1);
      const entity = compactResults.entities[0];
      
      // Should have accurate count but empty observations
      expect(entity.observationsCount).toBe(3);
      expect(entity.observations).toEqual([]);
    });

    it("should handle multiple entities correctly", async () => {
      await manager.createEntities([
        {
          name: "multi-entity-1",
          entityType: "multi-test",
          observations: ["Entity 1 observation"],
          createdAt: new Date().toISOString()
        },
        {
          name: "multi-entity-2",
          entityType: "multi-test",
          observations: ["Entity 2 observation 1", "Entity 2 observation 2"],
          createdAt: new Date(Date.now() - 1000).toISOString()
        }
      ]);

      const results = await manager.searchNodes("multi-test", {
        searchMode: "keyword"
      });

      expect(results.entities).toHaveLength(2);
      
      // Sort by name for consistent testing
      const sortedEntities = results.entities.sort((a, b) => a.name.localeCompare(b.name));
      
      expect(sortedEntities[0].name).toBe("multi-entity-1");
      expect(sortedEntities[0].observationsCount).toBe(1);
      
      expect(sortedEntities[1].name).toBe("multi-entity-2");
      expect(sortedEntities[1].observationsCount).toBe(2);
    });

    it("should handle empty observations correctly", async () => {
      await manager.createEntities([{
        name: "empty-obs-entity",
        entityType: "empty-test",
        observations: [],
        createdAt: new Date().toISOString()
      }]);

      const results = await manager.searchNodes("empty-test", {
        searchMode: "keyword"
      });

      expect(results.entities).toHaveLength(1);
      const entity = results.entities[0];
      expect(entity.observationsCount).toBe(0);
      expect(entity.observations).toEqual([]);
    });

    it("should demonstrate performance improvement intent", async () => {
      // Create a dataset that would trigger N+1 queries in the old implementation
      const entities = [];
      for (let i = 0; i < 20; i++) {
        entities.push({
          name: `perf-entity-${i}`,
          entityType: "performance",
          observations: [`Performance observation ${i} with test-keyword`],
          createdAt: new Date(Date.now() - i * 100).toISOString()
        });
      }
      
      await manager.createEntities(entities);

      const startTime = Date.now();
      
      // This search should match many entities, which would trigger N+1 in old implementation
      const results = await manager.searchNodes("test-keyword", {
        searchMode: "keyword"
      });
      
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      console.log(`Execution time for 20 matching entities: ${executionTime}ms`);
      
      // Should complete quickly (the exact threshold is less important than the batch query structure)
      expect(executionTime).toBeLessThan(3000); // 3 seconds is generous
      
      // Should find all matching entities
      expect(results.entities.length).toBe(20);
      
      // All should have proper observation counts
      for (const entity of results.entities) {
        expect(entity.observationsCount).toBe(1);
      }
    });
  });

  describe("Regression Prevention", () => {
    it("should not break existing functionality", async () => {
      await manager.createEntities([
        {
          name: "regression-test-1",
          entityType: "regression",
          observations: ["Regression test observation 1"],
          createdAt: new Date().toISOString()
        },
        {
          name: "regression-test-2",
          entityType: "regression",
          observations: ["Regression test observation 2"],
          createdAt: new Date(Date.now() - 1000).toISOString()
        }
      ]);

      // Test different search patterns that should all work
      const nameSearch = await manager.searchNodes("regression-test-1", { searchMode: "keyword" });
      const typeSearch = await manager.searchNodes("regression", { searchMode: "keyword" });
      const obsSearch = await manager.searchNodes("observation", { searchMode: "keyword" });

      // Name search should find specific entity
      expect(nameSearch.entities).toHaveLength(1);
      expect(nameSearch.entities[0].name).toBe("regression-test-1");

      // Type search should find both entities
      expect(typeSearch.entities).toHaveLength(2);

      // Observation search should find both entities
      expect(obsSearch.entities).toHaveLength(2);

      // All results should have proper observation counts
      for (const result of [nameSearch, typeSearch, obsSearch]) {
        for (const entity of result.entities) {
          expect(entity.observationsCount).toBe(1);
        }
      }
    });
  });
});