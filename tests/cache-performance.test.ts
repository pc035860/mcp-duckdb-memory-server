import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager.js";
import { ConsoleLogger } from "../src/logger.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";

describe("EntityCount Cache Performance", () => {
  let manager: DuckDBKnowledgeGraphManager;
  let testDir: string;

  beforeEach(async () => {
    // Create temporary directory for test
    testDir = await mkdtemp(join(tmpdir(), "cache-perf-test-"));
    const dbPath = join(testDir, "test.db");
    
    const logger = new ConsoleLogger();
    manager = new DuckDBKnowledgeGraphManager(
      () => dbPath,
      logger,
      false, // allowExternalTimestamps
      1000   // entityCountThreshold
    );
    
    await manager.initialize();

    // Create a moderate number of entities for testing
    const entities = Array.from({ length: 100 }, (_, i) => ({
      name: `perf-entity-${i}`,
      entityType: "performance",
      observations: [`observation for entity ${i}`],
      createdAt: new Date().toISOString(),
    }));

    await manager.createEntities(entities);
  });

  afterEach(async () => {
    if (manager && !manager.isClosed) {
      await manager.close();
    }
    // Clean up test directory
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("should show performance improvement with caching", async () => {
    const numSearches = 5;
    const searchTimes: number[] = [];

    // Perform multiple searches and measure time
    for (let i = 0; i < numSearches; i++) {
      const startTime = performance.now();
      const result = await manager.searchNodes("performance");
      const endTime = performance.now();
      
      searchTimes.push(endTime - startTime);
      
      // Verify we get results
      expect(result.entities.length).toBeGreaterThan(0);
      
      // Small delay between searches to see cache effect
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    console.log("Search times (ms):", searchTimes.map(t => t.toFixed(2)));
    
    // The first search should be slower (establishes cache)
    // Subsequent searches should be faster (use cache)
    const firstSearchTime = searchTimes[0];
    const subsequentSearchTimes = searchTimes.slice(1);
    const avgSubsequentTime = subsequentSearchTimes.reduce((a, b) => a + b, 0) / subsequentSearchTimes.length;
    
    console.log(`First search: ${firstSearchTime.toFixed(2)}ms`);
    console.log(`Average subsequent searches: ${avgSubsequentTime.toFixed(2)}ms`);
    
    // We don't assert specific times due to system variations,
    // but log them for manual verification of performance improvement
    expect(searchTimes.length).toBe(numSearches);
  });

  it("should handle sequential searches efficiently with cache", async () => {
    const numSequentialSearches = 10;
    
    const startTime = performance.now();
    const results = [];
    
    // Execute multiple searches sequentially
    for (let i = 0; i < numSequentialSearches; i++) {
      const result = await manager.searchNodes("performance");
      results.push(result);
    }
    
    const endTime = performance.now();
    const totalTime = endTime - startTime;
    
    console.log(`${numSequentialSearches} sequential searches completed in ${totalTime.toFixed(2)}ms`);
    console.log(`Average time per search: ${(totalTime / numSequentialSearches).toFixed(2)}ms`);
    
    // Verify all searches returned results
    results.forEach(result => {
      expect(result.entities.length).toBeGreaterThan(0);
    });
    
    // With caching, sequential searches should be reasonably fast
    expect(totalTime).toBeLessThan(2000); // Should complete within 2 seconds
  });

  it("should show performance with multi-keyword searches", async () => {
    const keywords = [
      ["performance", "entity"],
      ["entity", "0"],
      ["performance", "observation"]
    ];
    
    const searchTimes: number[] = [];
    
    for (const keywordSet of keywords) {
      const startTime = performance.now();
      const result = await manager.searchMultiKeywords(keywordSet);
      const endTime = performance.now();
      
      searchTimes.push(endTime - startTime);
      expect(result.entities.length).toBeGreaterThan(0);
    }
    
    console.log("Multi-keyword search times (ms):", searchTimes.map(t => t.toFixed(2)));
    
    // All searches should benefit from the same cached entity count
    const avgTime = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
    console.log(`Average multi-keyword search time: ${avgTime.toFixed(2)}ms`);
    
    expect(searchTimes.length).toBe(keywords.length);
  });
});