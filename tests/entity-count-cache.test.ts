import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager.js";
import { ConsoleLogger } from "../src/logger.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";

describe("EntityCount Caching", () => {
  let manager: DuckDBKnowledgeGraphManager;
  let testDir: string;
  let logger: ConsoleLogger;

  beforeEach(async () => {
    // Create temporary directory for test
    testDir = await mkdtemp(join(tmpdir(), "entity-count-cache-test-"));
    const dbPath = join(testDir, "test.db");
    
    logger = new ConsoleLogger();
    // Spy on logger to track cache operations
    vi.spyOn(logger, "debug");

    manager = new DuckDBKnowledgeGraphManager(
      () => dbPath,
      logger,
      false, // allowExternalTimestamps
      1000   // entityCountThreshold
    );
    
    await manager.initialize();
  });

  afterEach(async () => {
    if (manager && !manager.isClosed) {
      await manager.close();
    }
    // Clean up test directory
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("should cache entity count and reuse it within TTL", async () => {
    // Create some entities
    const entities = [
      {
        name: "test-entity-1",
        entityType: "test",
        observations: ["observation 1"],
        createdAt: new Date().toISOString(),
      },
      {
        name: "test-entity-2", 
        entityType: "test",
        observations: ["observation 2"],
        createdAt: new Date().toISOString(),
      },
    ];

    await manager.createEntities(entities);

    // Clear debug logs from entity creation
    vi.clearAllMocks();

    // First search should trigger cache update
    const result1 = await manager.searchNodes("test");
    expect(result1.entities.length).toBe(2);

    // Second search should use cached value
    const result2 = await manager.searchNodes("test");
    expect(result2.entities.length).toBe(2);

    // Verify that cache was used in the second call
    const debugCalls = vi.mocked(logger.debug).mock.calls;
    const cacheUsageCalls = debugCalls.filter(call => 
      call[0]?.includes("Using cached entity count")
    );
    
    expect(cacheUsageCalls.length).toBeGreaterThan(0);
  });

  it("should clear cache after creating entities", async () => {
    // First search to establish cache
    await manager.searchNodes("test");
    
    // Clear debug logs
    vi.clearAllMocks();

    // Create new entities (should clear cache)
    const newEntities = [
      {
        name: "new-entity-1",
        entityType: "test",
        observations: ["new observation"],
        createdAt: new Date().toISOString(),
      },
    ];

    await manager.createEntities(newEntities);

    // Next search should update cache (not use cached value)
    await manager.searchNodes("test");

    // Verify that cache was cleared and updated
    const debugCalls = vi.mocked(logger.debug).mock.calls;
    const cacheClearCalls = debugCalls.filter(call => 
      call[0]?.includes("Clearing entity count cache")
    );
    const cacheUpdateCalls = debugCalls.filter(call => 
      call[0]?.includes("Updated entity count cache")
    );

    expect(cacheClearCalls.length).toBeGreaterThan(0);
    expect(cacheUpdateCalls.length).toBeGreaterThan(0);
  });

  it("should clear cache after deleting entities", async () => {
    // Create entities first
    const entities = [
      {
        name: "entity-to-delete",
        entityType: "test",
        observations: ["observation"],
        createdAt: new Date().toISOString(),
      },
    ];

    await manager.createEntities(entities);

    // Search to establish cache
    await manager.searchNodes("test");
    
    // Clear debug logs
    vi.clearAllMocks();

    // Delete entities (should clear cache)
    await manager.deleteEntities(["entity-to-delete"]);

    // Next search should update cache
    await manager.searchNodes("test");

    // Verify that cache was cleared
    const debugCalls = vi.mocked(logger.debug).mock.calls;
    const cacheClearCalls = debugCalls.filter(call => 
      call[0]?.includes("Clearing entity count cache")
    );

    expect(cacheClearCalls.length).toBeGreaterThan(0);
  });

  it("should work correctly with searchMultiKeywords", async () => {
    // Create entities
    const entities = [
      {
        name: "multi-test-1",
        entityType: "test",
        observations: ["keyword1 keyword2"],
        createdAt: new Date().toISOString(),
      },
      {
        name: "multi-test-2",
        entityType: "test", 
        observations: ["keyword2 keyword3"],
        createdAt: new Date().toISOString(),
      },
    ];

    await manager.createEntities(entities);

    // Clear debug logs
    vi.clearAllMocks();

    // First multi-keyword search should update cache
    const result1 = await manager.searchMultiKeywords(["keyword1", "keyword2"]);
    expect(result1.entities.length).toBeGreaterThan(0);

    // Second search should use cached count
    const result2 = await manager.searchMultiKeywords(["keyword2", "keyword3"]);
    expect(result2.entities.length).toBeGreaterThan(0);

    // Verify cache usage
    const debugCalls = vi.mocked(logger.debug).mock.calls;
    const cacheUsageCalls = debugCalls.filter(call => 
      call[0]?.includes("Using cached entity count")
    );
    
    expect(cacheUsageCalls.length).toBeGreaterThan(0);
  });
});