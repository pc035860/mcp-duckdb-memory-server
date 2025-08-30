import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { ConsoleLogger } from '../src/logger.js';
import { generateUniqueDbPath, cleanupTestDb } from './test-utils.js';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBVSSManager } from '../src/services/vss/vss-manager.js';
import type { VSSConfig } from '../src/types/vss.js';

// Minimal stub embedding service to provide model dimensions without external API
class StubEmbeddingService {
  getConfig() { return { model: 'text-embedding-3-small' }; }
  async checkHealth() { return true; }
}

function makeUnitVector(dim = 1536, index = 0): number[] {
  const v = new Array(dim).fill(0);
  v[index] = 1;
  return v;
}

const BASE_VSS_CONFIG: VSSConfig = {
  enabled: true,
  indexParams: { metric: 'cosine', efConstruction: 100, M: 8 },
  autoRebuild: { enabled: false, threshold: 0.1, batchSize: 50 },
  fallback: { enabled: true, fallbackToKeyword: true, healthCheckInterval: 60000 },
};

describe('VSS search binder compatibility (aux and non-aux)', () => {
  const dbPath = generateUniqueDbPath('vss-binder');
  let manager: DuckDBKnowledgeGraphManager;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    delete (process.env as any).OPENAI_API_KEY;
    manager = new DuckDBKnowledgeGraphManager(() => dbPath, new ConsoleLogger(), false, 10);
    await manager.initialize();
    conn = await (manager as any).getConnection();
  });

  afterAll(async () => {
    await manager.close();
    await cleanupTestDb(dbPath);
  });

  it('non-aux: entities search does not throw binder error', async () => {
    // Prepare one entity with embedding in entities table
    const eName = 'entity-non-aux-1';
    await manager.createEntities([
      { name: eName, entityType: 'test', observations: [], createdAt: new Date().toISOString() },
    ]);

    const vec = makeUnitVector(1536, 0);
    const vecStr = '[' + vec.join(',') + ']';
    await conn.run(
      `UPDATE entities SET embedding = ?::FLOAT[1536], embedding_model = 'test-model', embedding_updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
      [vecStr, eName]
    );

    // Initialize VSS manager (loads vss and creates indexes on entities)
    const vss = new DuckDBVSSManager(
      conn,
      new StubEmbeddingService() as any,
      { ...BASE_VSS_CONFIG, autoRebuild: { enabled: false, threshold: 0.1, batchSize: 50 } }
    );
    await vss.initialize();

    // Query with the same vector should succeed without binder error
    const results = await vss.searchWithVSS(vec, { threshold: 0.1, limit: 5, searchTarget: 'entities' });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].similarity).toBeGreaterThanOrEqual(0.1);
  });

  it('aux: entities search uses entity_embeddings and does not throw', async () => {
    // Create aux table and insert embedding
    await conn.run(`CREATE TABLE IF NOT EXISTS entity_embeddings (
      name VARCHAR PRIMARY KEY,
      embedding FLOAT[1536],
      embedding_model VARCHAR,
      embedding_updated_at TIMESTAMP
    )`);

    const auxName = 'entity-aux-1';
    await manager.createEntities([
      { name: auxName, entityType: 'test', observations: ['y'], createdAt: new Date().toISOString() },
    ]);

    const vec = makeUnitVector(1536, 1);
    const vecStr = '[' + vec.join(',') + ']';
    await conn.run(
      `INSERT OR REPLACE INTO entity_embeddings(name, embedding, embedding_model, embedding_updated_at)
       VALUES (?, ?::FLOAT[1536], 'test-model', CURRENT_TIMESTAMP)`,
      [auxName, vecStr]
    );

    const vss = new DuckDBVSSManager(
      conn,
      new StubEmbeddingService() as any,
      { ...BASE_VSS_CONFIG, autoRebuild: { enabled: false, threshold: 0.1, batchSize: 50 } }
    );
    await vss.initialize();

    const results = await vss.searchWithVSS(vec, { threshold: 0.1, limit: 5, searchTarget: 'entities' });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].similarity).toBeGreaterThanOrEqual(0.1);
  });

  it('observations: observation search does not throw binder error', async () => {
    const name = 'entity-observation-1';
    await manager.createEntities([
      { name, entityType: 'test', observations: [], createdAt: new Date().toISOString() },
    ]);

    // Insert an observation with embedding
    const vec = makeUnitVector(1536, 2);
    const vecStr = '[' + vec.join(',') + ']';
    await conn.run(
      `INSERT INTO observations(entityName, content, embedding, embedding_model, created_at)
       VALUES (?, ?, ?::FLOAT[1536], 'test-model', CURRENT_TIMESTAMP)`,
      [name, 'observation content', vecStr]
    );

    const vss = new DuckDBVSSManager(
      conn,
      new StubEmbeddingService() as any,
      { ...BASE_VSS_CONFIG, autoRebuild: { enabled: false, threshold: 0.1, batchSize: 50 } }
    );
    await vss.initialize();

    const results = await vss.searchWithVSS(vec, { threshold: 0.1, limit: 5, searchTarget: 'observations' });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchSource).toBe('observation');
    expect(results[0].similarity).toBeGreaterThanOrEqual(0.1);
    expect(results[0].matchedContent).toBe('observation content');
  });

  // Test parameter binding fallback mechanism
  describe('Parameter binding fallback mechanism', () => {
    it('should retry with string parameter mode on ANY type binding error', async () => {
      // Create a fresh VSS manager instance for this test
      const testVss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        { ...BASE_VSS_CONFIG, autoRebuild: { enabled: false, threshold: 0.1, batchSize: 50 } }
      );
      await testVss.initialize();

      // Prepare test entity with embedding
      const testEntityName = 'fallback-test-entity';
      await manager.createEntities([
        { name: testEntityName, entityType: 'test', observations: [], createdAt: new Date().toISOString() }
      ]);

      const vec = makeUnitVector(1536, 3);
      const vecStr = '[' + vec.join(',') + ']';
      await conn.run(
        `UPDATE entities SET embedding = ?::FLOAT[1536], embedding_model = 'test-model', embedding_updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
        [vecStr, testEntityName]
      );

      // Mock the executeQuery method to throw ANY type error on first call
      const originalExecuteQuery = (testVss as any).executeQuery;
      let queryCallCount = 0;
      
      (testVss as any).executeQuery = async function(sql: string, params: any[]) {
        queryCallCount++;
        if (queryCallCount === 1) {
          // First call: throw ANY type binding error to trigger fallback
          const error = new Error('Cannot create values of type ANY. Specify a specific type.');
          throw error;
        }
        // Second call: return mock successful result
        return [{
          name: testEntityName,
          entityType: 'test',
          createdAt: new Date().toISOString(),
          embedding: params[0], // The formatted embedding parameter
          similarity: 0.95
        }];
      };

      // Verify initial state: should not be in fallback mode
      expect((testVss as any).fallbackToStringParam).toBe(false);

      // Execute search - should succeed after fallback
      const results = await testVss.searchWithVSS(vec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'entities' 
      });

      // Verify results
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].similarity).toBeGreaterThanOrEqual(0.1);
      
      // Verify fallback mode was activated
      expect((testVss as any).fallbackToStringParam).toBe(true);
      
      // Verify retry happened (should have called executeQuery at least twice)
      expect(queryCallCount).toBeGreaterThanOrEqual(2);
    });

    it('should retry with string parameter mode on FLOAT[] binder mismatch error', async () => {
      // Create a fresh VSS manager instance
      const testVss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        { ...BASE_VSS_CONFIG, autoRebuild: { enabled: false, threshold: 0.1, batchSize: 50 } }
      );
      await testVss.initialize();

      // Prepare test entity with embedding
      const testEntityName = 'binder-test-entity';
      await manager.createEntities([
        { name: testEntityName, entityType: 'test', observations: [], createdAt: new Date().toISOString() }
      ]);

      const vec = makeUnitVector(1536, 4);
      const vecStr = '[' + vec.join(',') + ']';
      await conn.run(
        `UPDATE entities SET embedding = ?::FLOAT[1536], embedding_model = 'test-model', embedding_updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
        [vecStr, testEntityName]
      );

      // Mock to simulate FLOAT[] binder error
      const originalSearchEntitiesWithVSS = (testVss as any).searchEntitiesWithVSS;
      let callCount = 0;
      
      (testVss as any).searchEntitiesWithVSS = async function(...args: any[]) {
        callCount++;
        if (callCount === 1) {
          // First call: throw binder mismatch error
          const error = new Error('No function matches the given name and argument types array_cosine_similarity(FLOAT[], FLOAT[])');
          throw error;
        }
        // Second call: return mock successful result
        return [{
          entity: {
            name: testEntityName,
            entityType: 'test',
            observations: [],
            createdAt: new Date().toISOString()
          },
          similarity: 0.95,
          matchSource: 'entity' as const
        }];
      };

      // Verify initial state
      expect((testVss as any).fallbackToStringParam).toBe(false);

      // Execute search - should succeed after fallback
      const results = await testVss.searchWithVSS(vec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'entities' 
      });

      // Verify results
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      
      // Verify fallback mode was activated
      expect((testVss as any).fallbackToStringParam).toBe(true);
      
      // Verify retry happened exactly once
      expect(callCount).toBe(2);
    });

    it('should use formatEmbeddingParam correctly in fallback mode', async () => {
      const testVss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await testVss.initialize();

      // Manually enable fallback mode
      (testVss as any).fallbackToStringParam = true;

      const testVector = [0.1, 0.2, 0.3];
      
      // Test formatEmbeddingParam behavior in fallback mode
      const formattedParam = (testVss as any).formatEmbeddingParam(testVector);
      expect(formattedParam).toBe('[0.1,0.2,0.3]');
      expect(typeof formattedParam).toBe('string');
      
      // Test formatEmbeddingParam behavior in normal mode
      (testVss as any).fallbackToStringParam = false;
      const normalParam = (testVss as any).formatEmbeddingParam(testVector);
      expect(normalParam).toEqual(testVector);
      expect(Array.isArray(normalParam)).toBe(true);
    });

    it('should not retry more than once on binding errors', async () => {
      const testVss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await testVss.initialize();

      // Mock to always throw ANY type error
      const originalSearchEntitiesWithVSS = (testVss as any).searchEntitiesWithVSS;
      let callCount = 0;
      
      (testVss as any).searchEntitiesWithVSS = async function(...args: any[]) {
        callCount++;
        // Always throw error to test retry limit
        const error = new Error('Cannot create values of type ANY');
        throw error;
      };

      const vec = makeUnitVector(1536, 5);
      
      // Should throw after exactly 2 attempts
      await expect(testVss.searchWithVSS(vec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'entities' 
      })).rejects.toThrow('VSS search failed');
      
      // Verify exactly 2 attempts were made
      expect(callCount).toBe(2);
      
      // Verify fallback mode was activated
      expect((testVss as any).fallbackToStringParam).toBe(true);
    });
  });

  // Test BigInt serialization and createdAt normalization
  describe('BigInt serialization and createdAt normalization', () => {
    it('should properly serialize VSS search results without BigInt errors', async () => {
      // Setup entity with embedding
      const entityName = 'bigint-test-entity';
      await manager.createEntities([
        { name: entityName, entityType: 'test', observations: [], createdAt: '2024-01-15T10:30:00Z' }
      ]);

      const vec = makeUnitVector(1536, 6);
      const vecStr = '[' + vec.join(',') + ']';
      await conn.run(
        `UPDATE entities SET embedding = ?::FLOAT[1536], embedding_model = 'test-model', embedding_updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
        [vecStr, entityName]
      );

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Execute search
      const results = await vss.searchWithVSS(vec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'entities' 
      });

      expect(results.length).toBeGreaterThan(0);
      const result = results[0];
      
      // Verify createdAt is a proper ISO string, not BigInt
      expect(typeof result.createdAt).toBe('string');
      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/);
      
      // Verify JSON serialization works without BigInt errors
      expect(() => JSON.stringify(results)).not.toThrow();
      
      const serialized = JSON.stringify(results);
      expect(serialized).toContain(entityName);
      expect(serialized).toContain('createdAt');
      
      // Verify deserialization works correctly
      const deserialized = JSON.parse(serialized);
      expect(deserialized[0].createdAt).toBe(result.createdAt);
    });

    it('should handle observations with proper createdAt serialization', async () => {
      const entityName = 'observation-bigint-test';
      await manager.createEntities([
        { name: entityName, entityType: 'test', observations: [], createdAt: new Date().toISOString() }
      ]);

      // Insert observation with embedding
      const vec = makeUnitVector(1536, 7);
      const vecStr = '[' + vec.join(',') + ']';
      await conn.run(
        `INSERT INTO observations(entityName, content, embedding, embedding_model, created_at)
         VALUES (?, ?, ?::FLOAT[1536], 'test-model', '2024-02-20T15:45:30Z')`,
        [entityName, 'test observation content', vecStr]
      );

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Search observations
      const results = await vss.searchWithVSS(vec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'observations' 
      });

      expect(results.length).toBeGreaterThan(0);
      const result = results[0];
      
      // Verify observation-specific fields
      expect(result.matchSource).toBe('observation');
      expect(result.matchedContent).toBe('test observation content');
      
      // Verify createdAt serialization
      expect(typeof result.createdAt).toBe('string');
      expect(() => JSON.stringify(results)).not.toThrow();
      
      const serialized = JSON.stringify(results);
      const deserialized = JSON.parse(serialized);
      expect(deserialized[0].createdAt).toBe(result.createdAt);
    });
  });
});


