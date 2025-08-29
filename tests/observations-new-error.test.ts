import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager';
import { ConsoleLogger } from '../src/logger';
import { generateUniqueDbPath, cleanupTestDb, safeCloseManager } from './test-utils';

/**
 * Direct test for observations_new error
 * This test verifies that the specific error with observations_new table no longer occurs
 */
describe('Direct observations_new Error Test', () => {
  let testDbPath: string;
  let manager: DuckDBKnowledgeGraphManager;
  let logger: ConsoleLogger;

  beforeEach(() => {
    logger = new ConsoleLogger('error'); // Only show errors
  });

  afterEach(async () => {
    if (manager) {
      await safeCloseManager(manager);
    }
    if (testDbPath) {
      await cleanupTestDb(testDbPath);
    }
  });

  it('should NOT get observations_new error when deleting entities', async () => {
    testDbPath = generateUniqueDbPath('obs-new-direct');
    
    // Create manager with FTS enabled
    manager = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      10 // Low threshold to trigger FTS
    );
    
    await manager.initialize();

    // Create test entities with observations
    const entities = [];
    for (let i = 1; i <= 15; i++) {
      entities.push({
        name: `test-entity-${i}`,
        entityType: 'test',
        observations: [`observation ${i}`, `data ${i}`],
        createdAt: new Date().toISOString()
      });
    }
    
    await manager.createEntities(entities);

    // This operation should NOT fail with observations_new error
    await expect(
      manager.deleteEntities(['test-entity-1', 'test-entity-2', 'test-entity-3'])
    ).resolves.toBeUndefined();

    // Verify entities were actually deleted
    const result = await manager.readGraph();
    expect(result.entities).toHaveLength(12);
    
    const names = result.entities.map(e => e.name);
    expect(names).not.toContain('test-entity-1');
    expect(names).not.toContain('test-entity-2');
    expect(names).not.toContain('test-entity-3');
  });

  it('should handle delete operations after migration', async () => {
    testDbPath = generateUniqueDbPath('obs-new-migration');
    
    // First session: create database with entities
    manager = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      10
    );
    
    await manager.initialize();

    await manager.createEntities([
      {
        name: 'migrate-test-1',
        entityType: 'test',
        observations: ['test 1'],
        createdAt: new Date().toISOString()
      },
      {
        name: 'migrate-test-2',
        entityType: 'test',
        observations: ['test 2'],
        createdAt: new Date().toISOString()
      }
    ]);

    // Close and reopen to trigger migration check
    await manager.close();
    
    manager = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      10
    );
    
    await manager.initialize();

    // Delete operation should work without observations_new error
    await expect(
      manager.deleteEntities(['migrate-test-1'])
    ).resolves.toBeUndefined();

    // Verify deletion worked
    const result = await manager.readGraph();
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('migrate-test-2');
  });

  it('should handle rapid create-delete cycles without observations_new error', async () => {
    testDbPath = generateUniqueDbPath('obs-new-rapid');
    
    manager = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      5
    );
    
    await manager.initialize();

    // Rapid create-delete cycles
    for (let cycle = 1; cycle <= 3; cycle++) {
      // Create entities
      const entities = [];
      for (let i = 1; i <= 5; i++) {
        entities.push({
          name: `cycle-${cycle}-entity-${i}`,
          entityType: 'test',
          observations: [`cycle ${cycle} data ${i}`],
          createdAt: new Date().toISOString()
        });
      }
      await manager.createEntities(entities);

      // Delete some entities - should not fail with observations_new error
      await expect(
        manager.deleteEntities([
          `cycle-${cycle}-entity-1`,
          `cycle-${cycle}-entity-2`
        ])
      ).resolves.toBeUndefined();
    }

    // Final verification
    const result = await manager.readGraph();
    // Should have 3 cycles * 3 remaining entities = 9 entities
    expect(result.entities).toHaveLength(9);
  });

  it('should verify observations_new table does not exist in schema', async () => {
    testDbPath = generateUniqueDbPath('obs-new-schema');
    
    manager = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      10
    );
    
    await manager.initialize();

    // Check that observations_new table doesn't exist using manager's connection
    const conn = await (manager as any).getConnection();
    try {
      // Use the run method to check for table existence
      let tableExists = false;
      try {
        await conn.run(`SELECT 1 FROM observations_new LIMIT 1`);
        tableExists = true;
      } catch (error: any) {
        // Table doesn't exist - this is what we expect
        if (error.message && error.message.includes('observations_new')) {
          tableExists = false;
        } else {
          throw error;
        }
      }
      
      expect(tableExists).toBe(false);
    } finally {
      try { (conn as any).disconnect?.(); } catch {}
    }
  });

  it('should handle FTS rebuild after delete without referencing observations_new', async () => {
    testDbPath = generateUniqueDbPath('obs-new-fts');
    
    manager = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      5 // Very low threshold to trigger FTS quickly
    );
    
    await manager.initialize();

    // Create enough entities to trigger FTS
    const entities = [];
    for (let i = 1; i <= 10; i++) {
      entities.push({
        name: `fts-entity-${i}`,
        entityType: 'test',
        observations: [`searchable content ${i}`],
        createdAt: new Date().toISOString()
      });
    }
    await manager.createEntities(entities);

    // Wait for FTS to be built
    await new Promise(resolve => setTimeout(resolve, 6000));

    // Delete some entities - should work without observations_new error
    await expect(
      manager.deleteEntities(['fts-entity-1', 'fts-entity-2'])
    ).resolves.toBeUndefined();

    // Wait for FTS rebuild
    await new Promise(resolve => setTimeout(resolve, 6000));

    // Search should work correctly
    const searchResult = await manager.searchNodes('searchable content');
    expect(searchResult.entities).toHaveLength(8);
    
    const names = searchResult.entities.map(e => e.name);
    expect(names).not.toContain('fts-entity-1');
    expect(names).not.toContain('fts-entity-2');
  });
});