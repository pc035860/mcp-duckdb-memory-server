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
});


