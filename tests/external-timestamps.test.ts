import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, existsSync } from "fs";

describe("External Timestamps Control", () => {
  let testDbPath: string;
  let manager: DuckDBKnowledgeGraphManager;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `test-external-timestamps-${Date.now()}-${Math.random()}.db`);
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
    }
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe("Normal Usage (allowExternalTimestamps = false)", () => {
    beforeEach(async () => {
      // Create manager without allowExternalTimestamps (default false)
      manager = new DuckDBKnowledgeGraphManager(() => testDbPath);
      await manager.initialize();
    });

    it("should ignore createdAt in entities and use database timestamp", async () => {
      const fixedTimestamp = "2020-01-01T00:00:00.000Z";

      const entities = [
        {
          name: "test-entity", 
          entityType: "test",
          observations: ["test observation"],
          createdAt: fixedTimestamp  // This should be ignored
        }
      ];

      const createdEntities = await manager.createEntities(entities);
      
      expect(createdEntities).toHaveLength(1);
      const entity = createdEntities[0];
      
      // The createdAt should NOT be the fixed timestamp we provided
      expect(entity.createdAt).not.toBe(fixedTimestamp);
      
      // It should be a valid timestamp string, not the fixed one we passed
      expect(entity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(entity.createdAt).getFullYear()).toBeGreaterThan(2020);
    });

    it("should ignore createdAt in relations and use database timestamp", async () => {
      const fixedTimestamp = "2020-01-01T00:00:00.000Z";

      // First create entities
      await manager.createEntities([
        { name: "entity1", entityType: "test", observations: [] },
        { name: "entity2", entityType: "test", observations: [] }
      ]);

      const relations = [
        {
          from: "entity1",
          to: "entity2", 
          relationType: "test-relation",
          createdAt: fixedTimestamp  // This should be ignored
        }
      ];

      const createdRelations = await manager.createRelations(relations);
      
      expect(createdRelations).toHaveLength(1);
      const relation = createdRelations[0];
      
      // The createdAt should NOT be the fixed timestamp we provided
      expect(relation.createdAt).not.toBe(fixedTimestamp);
      
      // It should be a valid timestamp string, not the fixed one we passed
      expect(relation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(relation.createdAt!).getFullYear()).toBeGreaterThan(2020);
    });

    it("should work normally even when entities don't have createdAt", async () => {
      const entities = [
        {
          name: "normal-entity", 
          entityType: "test",
          observations: ["normal observation"]
          // No createdAt provided
        }
      ];

      const createdEntities = await manager.createEntities(entities);
      
      expect(createdEntities).toHaveLength(1);
      const entity = createdEntities[0];
      
      // Should have a valid recent timestamp from database
      expect(entity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(entity.createdAt).getFullYear()).toBeGreaterThan(2020);
    });
  });

  describe("Merge Usage (allowExternalTimestamps = true)", () => {
    beforeEach(async () => {
      // Create manager with allowExternalTimestamps = true
      manager = new DuckDBKnowledgeGraphManager(() => testDbPath, undefined, true);
      await manager.initialize();
    });

    it("should respect createdAt in entities when allowed", async () => {
      const fixedTimestamp = "2020-01-01T00:00:00.000Z";

      const entities = [
        {
          name: "test-entity", 
          entityType: "test",
          observations: ["test observation"],
          createdAt: fixedTimestamp
        }
      ];

      const createdEntities = await manager.createEntities(entities);
      
      expect(createdEntities).toHaveLength(1);
      const entity = createdEntities[0];
      
      // The createdAt should be exactly the fixed timestamp we provided
      expect(entity.createdAt).toBe(fixedTimestamp);
    });

    it("should respect createdAt in relations when allowed", async () => {
      const fixedTimestamp = "2020-01-01T00:00:00.000Z";

      // First create entities
      await manager.createEntities([
        { name: "entity1", entityType: "test", observations: [] },
        { name: "entity2", entityType: "test", observations: [] }
      ]);

      const relations = [
        {
          from: "entity1",
          to: "entity2", 
          relationType: "test-relation",
          createdAt: fixedTimestamp
        }
      ];

      const createdRelations = await manager.createRelations(relations);
      
      expect(createdRelations).toHaveLength(1);
      const relation = createdRelations[0];
      
      // The createdAt should be exactly the fixed timestamp we provided
      expect(relation.createdAt).toBe(fixedTimestamp);
    });

    it("should still use database timestamp when createdAt is not provided", async () => {
      const entities = [
        {
          name: "no-timestamp-entity", 
          entityType: "test",
          observations: ["test observation"]
          // No createdAt provided
        }
      ];

      const createdEntities = await manager.createEntities(entities);
      
      expect(createdEntities).toHaveLength(1);
      const entity = createdEntities[0];
      
      // Should have a valid recent timestamp from database
      expect(entity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(entity.createdAt).getFullYear()).toBeGreaterThan(2020);
    });
  });
});