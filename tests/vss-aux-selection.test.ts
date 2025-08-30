import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { ConsoleLogger } from '../src/logger.js';
import { generateUniqueDbPath, cleanupTestDb } from './test-utils.js';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBVSSManager } from '../src/services/vss/vss-manager.js';
import type { VSSConfig } from '../src/types/vss.js';

// Minimal stub embedding service
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

describe('VSS Aux Selection (isAuxSearchable)', () => {
  let dbPath: string;
  let manager: DuckDBKnowledgeGraphManager;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    dbPath = generateUniqueDbPath('vss-aux-selection');
    delete (process.env as any).OPENAI_API_KEY;
    manager = new DuckDBKnowledgeGraphManager(() => dbPath, new ConsoleLogger(), false, 10);
    await manager.initialize();
    conn = await (manager as any).getConnection();
    // Ensure fresh aux table state for each test
    try {
      await conn.run('DROP TABLE IF EXISTS entity_embeddings');
    } catch {}
  });

  afterEach(async () => {
    await manager.close();
    await cleanupTestDb(dbPath);
  });

  describe('Aux table existence detection', () => {
    it('should return false when entity_embeddings table does not exist', async () => {
      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Verify aux table doesn't exist
      const isAvailable = await (vss as any).isEntityEmbeddingsAvailable();
      expect(isAvailable).toBe(false);

      // isAuxSearchable should return false
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(false);
    });

    it('should return false when entity_embeddings table exists but is empty', async () => {
      // Create empty aux table
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Verify table exists but is empty
      const isAvailable = await (vss as any).isEntityEmbeddingsAvailable();
      expect(isAvailable).toBe(true);

      // Should return false because no valid vectors
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(false);
    });

    it('should return false when entity_embeddings has NULL embeddings only', async () => {
      // Create aux table with NULL embeddings
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      // Insert entities with NULL embeddings
      await conn.run(`INSERT INTO entity_embeddings (name, embedding) VALUES ('test1', NULL)`);
      await conn.run(`INSERT INTO entity_embeddings (name, embedding) VALUES ('test2', NULL)`);

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Should return false - no valid vectors
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(false);
    });
  });

  describe('Aux table with valid vectors', () => {
    it('should return true when entity_embeddings has valid vectors', async () => {
      // Create aux table
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      // Insert valid embeddings
      const vec1 = makeUnitVector(1536, 0);
      const vec2 = makeUnitVector(1536, 1);
      const vecStr1 = '[' + vec1.join(',') + ']';
      const vecStr2 = '[' + vec2.join(',') + ']';

      await conn.run(
        `INSERT INTO entity_embeddings (name, embedding, embedding_model) 
         VALUES ('aux-entity-1', ?::FLOAT[1536], 'test-model')`,
        [vecStr1]
      );
      await conn.run(
        `INSERT INTO entity_embeddings (name, embedding, embedding_model) 
         VALUES ('aux-entity-2', ?::FLOAT[1536], 'test-model')`,
        [vecStr2]
      );

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Should return true - has valid vectors
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(true);
    });

    it('should return true even with mixed NULL and valid embeddings', async () => {
      // Create aux table
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      // Insert mix of NULL and valid embeddings
      const validVec = makeUnitVector(1536, 0);
      const validVecStr = '[' + validVec.join(',') + ']';

      await conn.run(`INSERT INTO entity_embeddings (name, embedding) VALUES ('null-entity', NULL)`);
      await conn.run(
        `INSERT INTO entity_embeddings (name, embedding, embedding_model) 
         VALUES ('valid-entity', ?::FLOAT[1536], 'test-model')`,
        [validVecStr]
      );
      await conn.run(`INSERT INTO entity_embeddings (name, embedding) VALUES ('another-null', NULL)`);

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Should return true - at least one valid vector exists
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(true);
    });
  });

  describe('Search path selection and results', () => {
    it('should use non-aux path when aux table is empty and return results from entities table', async () => {
      // Setup: Create empty aux table
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      // Setup: Create entity with embedding in entities table
      const entityName = 'non-aux-test-entity-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      await manager.createEntities([
        { name: entityName, entityType: 'test', observations: [], createdAt: new Date().toISOString() }
      ]);

      const vec = makeUnitVector(1536, 0);
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

      // Verify aux is not searchable
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(false);

      // Search should use non-aux path and find results
      const results = await vss.searchWithVSS(vec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'entities' 
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entity.name).toBe(entityName);
      expect(results[0].similarity).toBeGreaterThanOrEqual(0.9);
    });

    it('should use aux path when aux table has valid vectors and return results', async () => {
      // Setup: Create aux table with valid vectors
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      // Setup: Create entity in entities table
      const entityName = 'aux-selection-test-entity-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      await manager.createEntities([
        { name: entityName, entityType: 'test', observations: ['test observation'], createdAt: new Date().toISOString() }
      ]);

      // Setup: Add embedding to aux table
      const vec = makeUnitVector(1536, 1);
      const vecStr = '[' + vec.join(',') + ']';
      await conn.run(
        `INSERT OR REPLACE INTO entity_embeddings (name, embedding, embedding_model, embedding_updated_at)
         VALUES (?, ?::FLOAT[1536], 'test-model', CURRENT_TIMESTAMP)`,
        [entityName, vecStr]
      );

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Verify aux is searchable
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(true);

      // Search should use aux path and find results
      const results = await vss.searchWithVSS(vec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'entities' 
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entity.name).toBe(entityName);
      expect(results[0].entity.entityType).toBe('test');
      expect(results[0].similarity).toBeGreaterThanOrEqual(0.9);
    });

    it('should prioritize aux path over entities table when both have embeddings', async () => {
      // Setup: Create aux table
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      const entityName = 'dual-embedding-test-entity-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      
      // Setup: Create entity
      await manager.createEntities([
        { name: entityName, entityType: 'test', observations: [], createdAt: new Date().toISOString() }
      ]);

      // Setup: Add different embeddings to both tables
      const entitiesVec = makeUnitVector(1536, 0);  // Different vector
      const auxVec = makeUnitVector(1536, 1);       // Different vector
      const entitiesVecStr = '[' + entitiesVec.join(',') + ']';
      const auxVecStr = '[' + auxVec.join(',') + ']';

      // Add to entities table
      await conn.run(
        `UPDATE entities SET embedding = ?::FLOAT[1536], embedding_model = 'entities-model' WHERE name = ?`,
        [entitiesVecStr, entityName]
      );

      // Add to aux table
      await conn.run(
        `INSERT OR REPLACE INTO entity_embeddings (name, embedding, embedding_model)
         VALUES (?, ?::FLOAT[1536], 'aux-model')`,
        [entityName, auxVecStr]
      );

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Verify aux is chosen
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(true);

      // Search with aux vector should return high similarity (aux path is used)
      const auxResults = await vss.searchWithVSS(auxVec, { 
        threshold: 0.1, 
        limit: 5, 
        searchTarget: 'entities' 
      });

      expect(auxResults.length).toBeGreaterThan(0);
      expect(auxResults[0].entity.name).toBe(entityName);
      expect(auxResults[0].similarity).toBeGreaterThanOrEqual(0.9);

      // Search with entities vector should return lower similarity (aux embedding is used, not entities embedding)
      const entitiesResults = await vss.searchWithVSS(entitiesVec, { 
        threshold: -1.0,  // Allow negative cosine similarity when vectors differ
        limit: 5, 
        searchTarget: 'entities' 
      });

      // Should still find the entity but with lower similarity (since aux embedding is different)
      expect(entitiesResults.length).toBeGreaterThan(0);
      expect(entitiesResults[0].entity.name).toBe(entityName);
      expect(entitiesResults[0].similarity).toBeLessThan(0.9);  // Different embedding = lower similarity
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle aux table query errors gracefully', async () => {
      // Create malformed aux table to trigger query errors
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[100], -- Wrong dimension
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      // Insert data with wrong dimension
      const wrongVec = Array(100).fill(0.1);
      const wrongVecStr = '[' + wrongVec.join(',') + ']';
      await conn.run(
        `INSERT INTO entity_embeddings (name, embedding) VALUES ('wrong-dim', ?::FLOAT[100])`,
        [wrongVecStr]
      );

      const vss = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vss.initialize();

      // Should gracefully return false on query error
      const isAuxSearchable = await (vss as any).isAuxSearchable();
      expect(isAuxSearchable).toBe(false);
    });

    it('should handle empty search results correctly for both paths', async () => {
      // Test scenario 1: Non-aux path with no matching entities
      const vssNonAux = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vssNonAux.initialize();

      const randomVec = makeUnitVector(1536, 999);  // Very different vector
      const nonAuxResults = await vssNonAux.searchWithVSS(randomVec, { 
        threshold: 0.9,  // High threshold
        limit: 5, 
        searchTarget: 'entities' 
      });
      expect(nonAuxResults).toEqual([]);

      // Test scenario 2: Aux path with no matching entities
      await conn.run(`CREATE TABLE entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )`);

      const vec = makeUnitVector(1536, 0);
      const vecStr = '[' + vec.join(',') + ']';
      await conn.run(
        `INSERT INTO entity_embeddings (name, embedding) VALUES ('aux-test', ?::FLOAT[1536])`,
        [vecStr]
      );

      const vssAux = new DuckDBVSSManager(
        conn,
        new StubEmbeddingService() as any,
        BASE_VSS_CONFIG
      );
      await vssAux.initialize();

      const auxResults = await vssAux.searchWithVSS(randomVec, { 
        threshold: 0.9,  // High threshold
        limit: 5, 
        searchTarget: 'entities' 
      });
      expect(auxResults).toEqual([]);
    });
  });
});