import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { ConsoleLogger } from "../src/logger";
import * as path from "path";
import * as fs from "fs";

describe("Concurrency Control Integration Tests", () => {
  let manager: DuckDBKnowledgeGraphManager;
  let logger: ConsoleLogger;
  const testDbPath = path.join(__dirname, "test-concurrency.db");

  beforeEach(async () => {
    // Clean up any existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    logger = new ConsoleLogger();
    manager = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      1000 // entityCountThreshold
    );
    await manager.initialize();
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
    }
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe("Deletion and FTS Rebuild Conflict", () => {
    it("should prevent FTS rebuild during deletion", async () => {
      // Create some initial data
      await manager.createEntities([
        {
          name: "entity1",
          entityType: "test",
          observations: ["observation1", "observation2"],
        },
        {
          name: "entity2",
          entityType: "test",
          observations: ["observation3", "observation4"],
        },
      ]);

      // Start a deletion operation
      const deletionPromise = manager.deleteEntities(["entity1"]);

      // Immediately try to rebuild FTS indexes (should wait for deletion)
      const rebuildPromise = manager.rebuildFTSIndexes();

      // Both should complete without errors
      await expect(deletionPromise).resolves.toBeUndefined();
      await expect(rebuildPromise).resolves.toBeUndefined();

      // Verify deletion was successful
      const remainingEntities = await manager.openNodes(["entity1", "entity2"]);
      expect(remainingEntities.entities).toHaveLength(1);
      expect(remainingEntities.entities[0].name).toBe("entity2");
    });

    it("should serialize multiple deletion operations", async () => {
      // Create test data
      const entities = [];
      for (let i = 1; i <= 10; i++) {
        entities.push({
          name: `entity${i}`,
          entityType: "test",
          observations: [`obs${i}`],
        });
      }
      await manager.createEntities(entities);

      // Start multiple concurrent deletion operations
      const deletions = [];
      for (let i = 1; i <= 5; i++) {
        deletions.push(manager.deleteEntities([`entity${i}`]));
      }

      // All deletions should complete successfully
      await Promise.all(deletions);

      // Verify all deletions were successful
      const remaining = await manager.readGraph();
      expect(remaining.entities).toHaveLength(5);
      const remainingNames = remaining.entities.map(e => e.name);
      expect(remainingNames).toEqual(
        expect.arrayContaining(["entity6", "entity7", "entity8", "entity9", "entity10"])
      );
    });
  });

  describe("Bulk Write Operations", () => {
    it("should serialize concurrent bulk writes", async () => {
      const results = [];

      // Start multiple bulk write operations concurrently
      const operations = [];
      for (let i = 1; i <= 5; i++) {
        operations.push(
          manager.createEntities([
            {
              name: `batch${i}_entity1`,
              entityType: `type${i}`,
              observations: [`batch${i}_obs1`],
            },
            {
              name: `batch${i}_entity2`,
              entityType: `type${i}`,
              observations: [`batch${i}_obs2`],
            },
          ]).then(entities => {
            results.push(entities.length);
            return entities;
          })
        );
      }

      const allEntities = await Promise.all(operations);

      // All operations should complete successfully
      expect(results).toHaveLength(5);
      expect(results.every(r => r === 2)).toBe(true);

      // Verify all entities were created
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(10);
    });

    it("should handle mixed operations correctly", async () => {
      // Create initial data
      await manager.createEntities([
        {
          name: "permanent1",
          entityType: "permanent",
          observations: ["permanent_obs1"],
        },
        {
          name: "permanent2",
          entityType: "permanent",
          observations: ["permanent_obs2"],
        },
        {
          name: "to_delete",
          entityType: "temporary",
          observations: ["temp_obs"],
        },
      ]);

      // Start mixed operations concurrently
      const operations = Promise.all([
        // Create new entities
        manager.createEntities([
          {
            name: "new1",
            entityType: "new",
            observations: ["new_obs1"],
          },
        ]),
        // Add observations
        manager.addObservations([
          {
            entityName: "permanent1",
            contents: ["additional_obs1", "additional_obs2"],
          },
        ]),
        // Delete an entity
        manager.deleteEntities(["to_delete"]),
        // Create more entities
        manager.createEntities([
          {
            name: "new2",
            entityType: "new",
            observations: ["new_obs2"],
          },
        ]),
      ]);

      await operations;

      // Verify final state
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(4);
      
      const entityNames = graph.entities.map(e => e.name).sort();
      expect(entityNames).toEqual(["new1", "new2", "permanent1", "permanent2"]);

      // Verify observations were added
      const permanent1 = graph.entities.find(e => e.name === "permanent1");
      expect(permanent1?.observations).toEqual(
        expect.arrayContaining(["permanent_obs1", "additional_obs1", "additional_obs2"])
      );
    });
  });

  describe("Operation Status Monitoring", () => {
    it("should report operation status correctly", async () => {
      // Get initial status
      const initialStatus = manager.getOperationStatus();
      expect(initialStatus.states.deletion).toBe(false);
      expect(initialStatus.states.bulkWrite).toBe(false);
      expect(initialStatus.queueLength).toBe(0);

      // Start a long-running operation
      const createPromise = manager.createEntities([
        {
          name: "test_entity",
          entityType: "test",
          observations: Array.from({ length: 100 }, (_, i) => `obs${i}`),
        },
      ]);

      // Wait a bit for operation to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check status during operation
      const duringStatus = manager.getOperationStatus();
      expect(duringStatus.states.bulkWrite).toBe(true);

      await createPromise;

      // Check status after completion
      const afterStatus = manager.getOperationStatus();
      expect(afterStatus.states.bulkWrite).toBe(false);
      expect(afterStatus.queueLength).toBe(0);
    });
  });

  describe("Error Recovery", () => {
    it("should recover from operation failures", async () => {
      // Create an entity
      await manager.createEntities([
        {
          name: "test_entity",
          entityType: "test",
          observations: ["obs1"],
        },
      ]);

      // Try to create a duplicate (should fail but not affect other operations)
      const duplicatePromise = manager.createEntities([
        {
          name: "test_entity", // Duplicate
          entityType: "test",
          observations: ["obs2"],
        },
      ]);

      // Start another valid operation
      const validPromise = manager.createEntities([
        {
          name: "valid_entity",
          entityType: "test",
          observations: ["valid_obs"],
        },
      ]);

      // The duplicate should fail silently (entities are deduplicated)
      // but the valid operation should succeed
      await Promise.all([duplicatePromise, validPromise]);

      // Verify both entities exist
      const graph = await manager.readGraph();
      const entityNames = graph.entities.map(e => e.name).sort();
      expect(entityNames).toEqual(["test_entity", "valid_entity"]);
    });
  });

  describe("FTS Index Rebuild Coordination", () => {
    it("should coordinate FTS rebuilds with data operations", async () => {
      // Create enough entities to trigger FTS
      const entities = [];
      for (let i = 1; i <= 1001; i++) {
        entities.push({
          name: `entity${i}`,
          entityType: "test",
          observations: [`obs${i}`],
        });
      }
      
      // Create in batches to avoid timeout
      for (let i = 0; i < entities.length; i += 100) {
        await manager.createEntities(entities.slice(i, i + 100));
      }

      // Start multiple operations that might trigger FTS rebuild
      const operations = Promise.all([
        manager.deleteEntities(["entity1", "entity2", "entity3"]),
        manager.createEntities([
          {
            name: "new_entity",
            entityType: "new",
            observations: ["new_obs"],
          },
        ]),
        manager.rebuildFTSIndexes(), // Explicit rebuild
      ]);

      // All should complete without conflicts
      await expect(operations).resolves.toBeDefined();

      // Verify FTS is still functional
      const searchResults = await manager.searchNodes("new_obs");
      expect(searchResults.entities).toHaveLength(1);
      expect(searchResults.entities[0].name).toBe("new_entity");
    });
  });
});