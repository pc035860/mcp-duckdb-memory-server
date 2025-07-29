import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { ConsoleLogger } from '../src/logger.js';

describe('FTS Scalar Subquery Fix', () => {
  let manager: DuckDBKnowledgeGraphManager;
  const logger = new ConsoleLogger();

  beforeEach(async () => {
    manager = new DuckDBKnowledgeGraphManager(
      () => ':memory:',
      logger,
      false,
      0  // Force FTS usage
    );
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.close();
  });

  it('should handle BM25 search without scalar subquery errors', async () => {
    // Create entities with multiple observations
    const createdEntities = await manager.createEntities([
      {
        name: "test-entity-1",
        entityType: "test",
        observations: [
          "This is the first observation about Python programming",
          "This is the second observation about JavaScript development",
          "This is the third observation about TypeScript coding"
        ],
        createdAt: new Date().toISOString()
      },
      {
        name: "test-entity-2", 
        entityType: "test",
        observations: [
          "Python is a great language for data science",
          "Python has excellent libraries like pandas and numpy",
          "Python is used in machine learning"
        ],
        createdAt: new Date().toISOString()
      }
    ]);
    console.log('Created entities:', createdEntities.map(e => e.name));

    // Get all entities to verify they were created
    const allEntities = await manager.openNodes(["test-entity-1", "test-entity-2"]);
    console.log('Verified entities exist:', allEntities.entities.map(e => ({ name: e.name, observations: e.observations.length })));

    // Force FTS index rebuild
    await manager.rebuildFTSIndexes();

    // Wait a bit to ensure FTS indexes are ready
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check FTS info
    const ftsInfoBefore = await manager.getFTSInfo();
    console.log('FTS Info:', ftsInfoBefore);

    // Test BM25 search - this should not throw scalar subquery error
    const results = await manager.searchNodes("Python");
    console.log('Search results:', JSON.stringify(results, null, 2));
    
    // Try searching for a term in entity name instead
    const nameSearchResults = await manager.searchNodes("test-entity");
    console.log('Name search results:', nameSearchResults.entities.map(e => e.name));

    // Verify results
    expect(results.entities.length).toBeGreaterThan(0);
    expect(results.entities.some(e => e.name === "test-entity-1")).toBe(true);
    expect(results.entities.some(e => e.name === "test-entity-2")).toBe(true);
    
    // Verify search strategy
    const ftsInfo = await manager.getFTSInfo();
    console.log('Final FTS info:', ftsInfo);
  });

  it('should correctly search observations with multiple matches per entity', async () => {
    // Create entity with observations that all match the query
    await manager.createEntities([
      {
        name: "multi-match-entity",
        entityType: "test",
        observations: [
          "DuckDB is a great database",
          "DuckDB supports analytical queries",
          "DuckDB has excellent performance"
        ],
        createdAt: new Date().toISOString()
      }
    ]);

    await manager.rebuildFTSIndexes();

    // Wait a bit to ensure FTS indexes are ready
    await new Promise(resolve => setTimeout(resolve, 100));

    // Search for "DuckDB" - all observations match
    const results = await manager.searchNodes("DuckDB");
    console.log('Search results:', JSON.stringify(results, null, 2));

    expect(results.entities.length).toBe(1);
    expect(results.entities[0].name).toBe("multi-match-entity");
    expect(results.entities[0].observations.length).toBe(3);
  });
});