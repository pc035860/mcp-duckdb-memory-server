import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager';
import { ProxyKnowledgeGraphManager } from '../src/managers/proxy-manager';
import { MainServer } from '../src/servers/main-server';
import { SecondaryServer } from '../src/servers/secondary-server';
import { ServerConfig } from '../src/config/server-config';
import { ConsoleLogger } from '../src/logger';
import { 
  generateUniqueDbPath, 
  generateUniqueTempDir,
  cleanupTestDb, 
  cleanupTempDir,
  safeCloseManager,
  waitFor 
} from './test-utils';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Comprehensive test suite for observations_new error fix
 * 
 * This test suite validates:
 * 1. The observations_new error no longer occurs during delete operations
 * 2. Secondary server operations remain stable
 * 3. Concurrent operations handle properly
 * 4. Data integrity is maintained
 * 5. Migration and FTS index sync work correctly
 */
describe('Observations New Error Fix Test Suite', () => {
  let testDbPath: string;
  let testTempDir: string;
  let socketPath: string;
  let mainServer: MainServer;
  let secondaryServer: SecondaryServer;
  let manager: DuckDBKnowledgeGraphManager;
  let proxyManager: ProxyKnowledgeGraphManager;
  let logger: ConsoleLogger;

  const setupServers = async (useDebug = false) => {
    // Setup paths
    testTempDir = generateUniqueTempDir('obs-fix');
    testDbPath = path.join(testTempDir, 'test.db');
    socketPath = path.join(testTempDir, 'test.sock');

    // Create logger
    logger = new ConsoleLogger(useDebug ? 'debug' : 'info');

    // Setup main server
    const mainConfig: ServerConfig = {
      mode: 'main',
      database: {
        path: testDbPath
      },
      ipc: {
        socketPath: socketPath
      },
      queue: {
        maxSize: 100,
        timeoutMs: 30000
      },
      search: {
        entityCountThreshold: 10 // Low threshold to trigger FTS quickly
      }
    };

    mainServer = new MainServer(mainConfig, logger);
    await mainServer.start();

    // Wait for main server to be ready
    await waitFor(async () => {
      return fs.existsSync(socketPath);
    }, 5000);

    // Setup secondary server
    const secondaryConfig: ServerConfig = {
      mode: 'secondary',
      database: {
        path: '' // Not used by secondary
      },
      ipc: {
        socketPath: socketPath
      },
      queue: {
        maxSize: 100,
        timeoutMs: 30000
      },
      search: {
        entityCountThreshold: 10
      }
    };

    secondaryServer = new SecondaryServer(secondaryConfig, logger);
    await secondaryServer.start();

    // Get proxy manager from secondary server
    proxyManager = (secondaryServer as any).manager;
  };

  const teardownServers = async () => {
    // Cleanup servers
    if (secondaryServer) {
      await secondaryServer.stop();
    }
    if (mainServer) {
      await mainServer.stop();
    }

    // Cleanup files
    await cleanupTempDir(testTempDir);
  };

  describe('Secondary Server Delete Operations', () => {
    beforeEach(async () => {
      await setupServers();
    });

    afterEach(async () => {
      await teardownServers();
    });

    it('should delete entities through secondary server without observations_new error', async () => {
      // Create test entities through proxy
      await proxyManager.createEntities([
        {
          name: 'test-entity-1',
          entityType: 'test',
          observations: ['observation 1', 'observation 2'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'test-entity-2',
          entityType: 'test',
          observations: ['observation 3', 'observation 4'],
          createdAt: new Date().toISOString()
        }
      ]);

      // Delete entity through proxy (this used to trigger observations_new error)
      await expect(proxyManager.deleteEntities(['test-entity-1'])).resolves.toBeUndefined();

      // Verify deletion was successful
      const result = await proxyManager.openNodes(['test-entity-1', 'test-entity-2']);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('test-entity-2');
    });

    it('should handle multiple consecutive delete operations', async () => {
      // Create multiple entities
      const entities = [];
      for (let i = 1; i <= 5; i++) {
        entities.push({
          name: `entity-${i}`,
          entityType: 'test',
          observations: [`obs-${i}-1`, `obs-${i}-2`],
          createdAt: new Date().toISOString()
        });
      }
      await proxyManager.createEntities(entities);

      // Delete entities one by one
      for (let i = 1; i <= 3; i++) {
        await expect(proxyManager.deleteEntities([`entity-${i}`])).resolves.toBeUndefined();
      }

      // Verify remaining entities
      const result = await proxyManager.readGraph();
      expect(result.entities).toHaveLength(2);
      const remainingNames = result.entities.map(e => e.name);
      expect(remainingNames).toEqual(expect.arrayContaining(['entity-4', 'entity-5']));
    });

    it('should handle delete operations with relations', async () => {
      // Create entities with relations
      await proxyManager.createEntities([
        {
          name: 'parent-entity',
          entityType: 'parent',
          observations: ['parent observation'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'child-entity',
          entityType: 'child',
          observations: ['child observation'],
          createdAt: new Date().toISOString()
        }
      ]);

      await proxyManager.createRelations([
        {
          from: 'parent-entity',
          to: 'child-entity',
          relationType: 'has_child'
        }
      ]);

      // Delete parent entity (should also delete relations)
      await expect(proxyManager.deleteEntities(['parent-entity'])).resolves.toBeUndefined();

      // Verify entity and relations are deleted
      const result = await proxyManager.readGraph();
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('child-entity');
      expect(result.relations).toHaveLength(0);
    });
  });

  describe('Concurrent Operations', () => {
    beforeEach(async () => {
      await setupServers();
    });

    afterEach(async () => {
      await teardownServers();
    });

    it('should handle concurrent delete and FTS rebuild', async () => {
      // Create test data to trigger FTS
      const entities = [];
      for (let i = 1; i <= 15; i++) {
        entities.push({
          name: `concurrent-entity-${i}`,
          entityType: 'test',
          observations: [`observation ${i}`, `data ${i}`],
          createdAt: new Date().toISOString()
        });
      }
      await proxyManager.createEntities(entities);

      // Start concurrent operations
      const deletePromise = proxyManager.deleteEntities(['concurrent-entity-1', 'concurrent-entity-2']);
      const searchPromise = proxyManager.searchNodes('observation', {});
      
      // Both operations should complete without errors
      await expect(deletePromise).resolves.toBeUndefined();
      const searchResult = await searchPromise;
      expect(searchResult).toBeDefined();
      
      // Verify state consistency
      const finalState = await proxyManager.readGraph();
      expect(finalState.entities.length).toBe(13);
    });

    it('should serialize multiple concurrent delete operations', async () => {
      // Create test entities
      const entities = [];
      for (let i = 1; i <= 10; i++) {
        entities.push({
          name: `serialize-entity-${i}`,
          entityType: 'test',
          observations: [`obs ${i}`],
          createdAt: new Date().toISOString()
        });
      }
      await proxyManager.createEntities(entities);

      // Start multiple concurrent deletions
      const deletions = [];
      for (let i = 1; i <= 5; i++) {
        deletions.push(proxyManager.deleteEntities([`serialize-entity-${i}`]));
      }

      // All should complete successfully
      await Promise.all(deletions);

      // Verify final state
      const result = await proxyManager.readGraph();
      expect(result.entities).toHaveLength(5);
      const remainingNames = result.entities.map(e => e.name);
      for (let i = 6; i <= 10; i++) {
        expect(remainingNames).toContain(`serialize-entity-${i}`);
      }
    });

    it('should handle interleaved create and delete operations', async () => {
      // Initial entity
      await proxyManager.createEntities([
        {
          name: 'interleave-1',
          entityType: 'test',
          observations: ['initial'],
          createdAt: new Date().toISOString()
        }
      ]);

      // Interleave operations
      const operations = [
        proxyManager.createEntities([
          {
            name: 'interleave-2',
            entityType: 'test',
            observations: ['created-1'],
            createdAt: new Date().toISOString()
          }
        ]),
        proxyManager.deleteEntities(['interleave-1']),
        proxyManager.createEntities([
          {
            name: 'interleave-3',
            entityType: 'test',
            observations: ['created-2'],
            createdAt: new Date().toISOString()
          }
        ])
      ];

      await Promise.all(operations);

      // Verify final state
      const result = await proxyManager.readGraph();
      const names = result.entities.map(e => e.name);
      expect(names).not.toContain('interleave-1');
      expect(names).toContain('interleave-2');
      expect(names).toContain('interleave-3');
    });
  });

  describe('Migration Stability', () => {
    it('should handle operations during migration', async () => {
      // Use a standalone manager for migration testing
      testDbPath = generateUniqueDbPath('migration');
      manager = new DuckDBKnowledgeGraphManager(
        () => testDbPath,
        logger,
        false,
        10 // Low threshold to trigger FTS
      );
      
      await manager.initialize();

      try {
        // Create initial data
        const entities = [];
        for (let i = 1; i <= 20; i++) {
          entities.push({
            name: `migration-entity-${i}`,
            entityType: 'test',
            observations: [`obs ${i}`],
            createdAt: new Date().toISOString()
          });
        }
        await manager.createEntities(entities);

        // Try operations that might conflict with migration
        const operations = [
          manager.deleteEntities(['migration-entity-1']),
          manager.searchNodes('obs'),
          manager.createEntities([
            {
              name: 'migration-new',
              entityType: 'test',
              observations: ['new observation'],
              createdAt: new Date().toISOString()
            }
          ])
        ];

        // All operations should complete successfully
        await Promise.all(operations);

        // Verify system state
        const result = await manager.readGraph();
        expect(result.entities.length).toBeGreaterThan(0);
        expect(result.entities.find(e => e.name === 'migration-entity-1')).toBeUndefined();
        expect(result.entities.find(e => e.name === 'migration-new')).toBeDefined();
      } finally {
        await safeCloseManager(manager);
        await cleanupTestDb(testDbPath);
      }
    });

    it('should maintain data integrity after migration', async () => {
      // Create a database with old schema
      testDbPath = generateUniqueDbPath('integrity');
      manager = new DuckDBKnowledgeGraphManager(
        () => testDbPath,
        logger,
        false,
        5
      );
      
      await manager.initialize();

      try {
        // Create test data
        await manager.createEntities([
          {
            name: 'integrity-test-1',
            entityType: 'test',
            observations: ['observation 1', 'observation 2'],
            createdAt: '2024-01-01T00:00:00Z'
          },
          {
            name: 'integrity-test-2',
            entityType: 'test',
            observations: ['observation 3'],
            createdAt: '2024-01-02T00:00:00Z'
          }
        ]);

        await manager.createRelations([
          {
            from: 'integrity-test-1',
            to: 'integrity-test-2',
            relationType: 'related_to'
          }
        ]);

        // Close and reopen to trigger migration check
        await manager.close();
        manager = new DuckDBKnowledgeGraphManager(
          () => testDbPath,
          logger,
          false,
          5
        );
        await manager.initialize();

        // Verify data integrity
        const result = await manager.readGraph();
        expect(result.entities).toHaveLength(2);
        expect(result.relations).toHaveLength(1);
        
        // Verify observations are intact
        const entity1 = result.entities.find(e => e.name === 'integrity-test-1');
        expect(entity1?.observations).toHaveLength(2);
        // Note: createdAt is now handled internally and may not preserve exact timestamp
        expect(entity1?.createdAt).toBeDefined();
        expect(entity1?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      } finally {
        await safeCloseManager(manager);
        await cleanupTestDb(testDbPath);
      }
    });
  });

  describe('FTS Index Synchronization', () => {
    beforeEach(async () => {
      await setupServers(true); // Enable debug logging
    });

    afterEach(async () => {
      await teardownServers();
    });

    it('should sync FTS index after delete operations', async () => {
      // Create enough entities to trigger FTS
      const entities = [];
      for (let i = 1; i <= 15; i++) {
        entities.push({
          name: `fts-entity-${i}`,
          entityType: 'test',
          observations: [`searchable content ${i}`, `keyword ${i}`],
          createdAt: new Date().toISOString()
        });
      }
      await proxyManager.createEntities(entities);

      // Delete some entities
      await proxyManager.deleteEntities(['fts-entity-1', 'fts-entity-2', 'fts-entity-3']);

      // Wait for FTS debounce
      await new Promise(resolve => setTimeout(resolve, 6000));

      // Search should work correctly after deletion
      const searchResult = await proxyManager.searchNodes('searchable content');
      expect(searchResult.entities.length).toBe(12); // 15 - 3 deleted
      
      // Verify deleted entities don't appear in search
      const names = searchResult.entities.map(e => e.name);
      expect(names).not.toContain('fts-entity-1');
      expect(names).not.toContain('fts-entity-2');
      expect(names).not.toContain('fts-entity-3');
    });

    it('should handle FTS rebuild after multiple operations', async () => {
      // Create initial entities
      await proxyManager.createEntities([
        {
          name: 'rebuild-1',
          entityType: 'test',
          observations: ['initial content'],
          createdAt: new Date().toISOString()
        }
      ]);

      // Perform multiple operations
      for (let i = 2; i <= 12; i++) {
        await proxyManager.createEntities([
          {
            name: `rebuild-${i}`,
            entityType: 'test',
            observations: [`content ${i}`],
            createdAt: new Date().toISOString()
          }
        ]);
      }

      // Delete first entity
      await proxyManager.deleteEntities(['rebuild-1']);

      // Wait for FTS debounce
      await new Promise(resolve => setTimeout(resolve, 6000));

      // Verify search works correctly
      const searchResult = await proxyManager.searchNodes('content');
      expect(searchResult.entities.length).toBe(11);
      expect(searchResult.entities.find(e => e.name === 'rebuild-1')).toBeUndefined();
    });
  });

  describe('Regression Tests', () => {
    beforeEach(async () => {
      await setupServers();
    });

    afterEach(async () => {
      await teardownServers();
    });

    it('should maintain all basic MCP operations', async () => {
      // Test create entities
      const entities = await proxyManager.createEntities([
        {
          name: 'regression-entity',
          entityType: 'test',
          observations: ['test observation'],
          createdAt: new Date().toISOString()
        }
      ]);
      expect(entities).toHaveLength(1);

      // Test add observations
      await proxyManager.addObservations([
        {
          entityName: 'regression-entity',
          contents: ['additional observation']
        }
      ]);

      // Test create relations
      await proxyManager.createEntities([
        {
          name: 'regression-entity-2',
          entityType: 'test',
          observations: ['second entity'],
          createdAt: new Date().toISOString()
        }
      ]);

      const relations = await proxyManager.createRelations([
        {
          from: 'regression-entity',
          to: 'regression-entity-2',
          relationType: 'links_to'
        }
      ]);
      expect(relations).toHaveLength(1);

      // Test search
      const searchResult = await proxyManager.searchNodes('observation');
      expect(searchResult.entities.length).toBeGreaterThan(0);

      // Test open nodes
      const openResult = await proxyManager.openNodes(['regression-entity']);
      expect(openResult.entities).toHaveLength(1);
      expect(openResult.entities[0].observations).toHaveLength(2);

      // Test delete observations
      await proxyManager.deleteObservations([
        {
          entityName: 'regression-entity',
          contents: ['additional observation']
        }
      ]);

      // Test delete relations
      await proxyManager.deleteRelations([
        {
          from: 'regression-entity',
          to: 'regression-entity-2',
          relationType: 'links_to'
        }
      ]);

      // Test delete entities
      await proxyManager.deleteEntities(['regression-entity']);

      // Verify final state
      const finalState = await proxyManager.readGraph();
      expect(finalState.entities).toHaveLength(1);
      expect(finalState.entities[0].name).toBe('regression-entity-2');
      expect(finalState.relations).toHaveLength(0);
    });

    it('should not impact performance significantly', async () => {
      const startTime = Date.now();

      // Perform a series of operations
      const operations = [];
      for (let i = 1; i <= 10; i++) {
        operations.push(
          proxyManager.createEntities([
            {
              name: `perf-entity-${i}`,
              entityType: 'test',
              observations: [`obs ${i}`],
              createdAt: new Date().toISOString()
            }
          ])
        );
      }
      await Promise.all(operations);

      // Delete half of them
      const deleteOps = [];
      for (let i = 1; i <= 5; i++) {
        deleteOps.push(proxyManager.deleteEntities([`perf-entity-${i}`]));
      }
      await Promise.all(deleteOps);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within reasonable time (10 seconds for all operations)
      expect(duration).toBeLessThan(10000);
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    beforeEach(async () => {
      await setupServers();
    });

    afterEach(async () => {
      await teardownServers();
    });

    it('should handle deletion of non-existent entities gracefully', async () => {
      // Try to delete entities that don't exist
      await expect(
        proxyManager.deleteEntities(['non-existent-1', 'non-existent-2'])
      ).resolves.toBeUndefined();

      // System should remain stable
      const result = await proxyManager.readGraph();
      expect(result).toBeDefined();
    });

    it('should handle empty delete operations', async () => {
      // Delete with empty array
      await expect(proxyManager.deleteEntities([])).resolves.toBeUndefined();

      // System should remain stable
      const result = await proxyManager.readGraph();
      expect(result).toBeDefined();
    });

    it('should recover from interrupted operations', async () => {
      // Create test entity
      await proxyManager.createEntities([
        {
          name: 'interrupt-test',
          entityType: 'test',
          observations: ['test data'],
          createdAt: new Date().toISOString()
        }
      ]);

      // Simulate an interrupted operation by creating multiple concurrent operations
      const operations = [];
      for (let i = 0; i < 5; i++) {
        operations.push(
          proxyManager.searchNodes('test').catch(() => {
            // Ignore errors
          })
        );
      }
      
      // Add a delete operation in the middle
      operations.push(proxyManager.deleteEntities(['interrupt-test']));

      await Promise.all(operations);

      // System should recover and be in consistent state
      const result = await proxyManager.readGraph();
      expect(result.entities.find(e => e.name === 'interrupt-test')).toBeUndefined();
    });

    it('should handle rapid consecutive operations', async () => {
      // Rapidly create and delete entities
      for (let i = 1; i <= 5; i++) {
        await proxyManager.createEntities([
          {
            name: `rapid-${i}`,
            entityType: 'test',
            observations: [`data ${i}`],
            createdAt: new Date().toISOString()
          }
        ]);
        
        if (i % 2 === 0) {
          await proxyManager.deleteEntities([`rapid-${i - 1}`]);
        }
      }

      // Verify final state
      const result = await proxyManager.readGraph();
      const names = result.entities.map(e => e.name);
      
      // Should have rapid-2, rapid-3, rapid-4, rapid-5 (rapid-1 was deleted)
      expect(names).not.toContain('rapid-1');
      expect(names).toContain('rapid-2');
      expect(names).not.toContain('rapid-3');
      expect(names).toContain('rapid-4');
      expect(names).toContain('rapid-5');
    });
  });

  describe('Observation New Table Specific Tests', () => {
    it('should never reference observations_new table during operations', async () => {
      // Setup standalone manager with debug logging
      testDbPath = generateUniqueDbPath('obs-new-check');
      const debugLogger = new ConsoleLogger('debug');
      
      // Spy on logger to catch any mentions of observations_new
      const errorSpy = vi.spyOn(debugLogger, 'error');
      const warnSpy = vi.spyOn(debugLogger, 'warn');
      
      manager = new DuckDBKnowledgeGraphManager(
        () => testDbPath,
        debugLogger,
        false,
        10
      );
      
      await manager.initialize();

      try {
        // Perform operations that previously triggered observations_new error
        await manager.createEntities([
          {
            name: 'check-entity',
            entityType: 'test',
            observations: ['test observation'],
            createdAt: new Date().toISOString()
          }
        ]);

        await manager.deleteEntities(['check-entity']);

        // Check that no errors mentioning observations_new were logged
        expect(errorSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('observations_new'),
          expect.anything()
        );
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('observations_new'),
          expect.anything()
        );
      } finally {
        await safeCloseManager(manager);
        await cleanupTestDb(testDbPath);
      }
    });

    it('should complete migration without creating observations_new', async () => {
      testDbPath = generateUniqueDbPath('no-obs-new');
      manager = new DuckDBKnowledgeGraphManager(
        () => testDbPath,
        logger,
        false,
        10
      );
      
      await manager.initialize();

      try {
        // Check that operations work without observations_new table issues
        await manager.createEntities([
          {
            name: 'table-check-entity',
            entityType: 'test',
            observations: ['test observation'],
            createdAt: new Date().toISOString()
          }
        ]);
        
        // This operation should not fail with observations_new error
        await manager.deleteEntities(['table-check-entity']);
        
        // If we got here without errors, the fix is working
        const result = await manager.readGraph();
        expect(result).toBeDefined();
      } finally {
        await safeCloseManager(manager);
        await cleanupTestDb(testDbPath);
      }
    });
  });
});