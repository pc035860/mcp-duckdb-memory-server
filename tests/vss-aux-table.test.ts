import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { ConsoleLogger } from '../src/logger.js';
import { generateUniqueDbPath, cleanupTestDb } from './test-utils.js';
import { DuckDBInstance } from '@duckdb/node-api';

describe('VSS uses entity_embeddings when available', () => {
  const dbPath = generateUniqueDbPath('vss-aux');
  let manager: DuckDBKnowledgeGraphManager;

  beforeAll(async () => {
    // 保持 VSS 關閉，避免外部 API 依賴
    delete (process.env as any).OPENAI_API_KEY;
    manager = new DuckDBKnowledgeGraphManager(() => dbPath, new ConsoleLogger(), false, 10);
    await manager.initialize();

    // Create two entities
    await manager.createEntities([
      { name: 'aux-entity-high', entityType: 'test', observations: ['A'], createdAt: new Date().toISOString() },
      { name: 'aux-entity-low', entityType: 'test', observations: ['B'], createdAt: new Date().toISOString() },
    ]);

    // Use manager's connection to create entity_embeddings with vectors (avoid WAL cross-instance)
    const conn = await (manager as any).getConnection();
    await conn.run(`
      CREATE TABLE IF NOT EXISTS entity_embeddings (
        name VARCHAR PRIMARY KEY,
        embedding FLOAT[1536],
        embedding_model VARCHAR,
        embedding_updated_at TIMESTAMP
      )
    `);

    const vecHigh = Array(1536).fill(0.9);
    const vecLow = Array(1536).fill(0.1);
    const highStr = '[' + vecHigh.join(',') + ']';
    const lowStr = '[' + vecLow.join(',') + ']';

    await conn.run(`INSERT OR REPLACE INTO entity_embeddings(name, embedding, embedding_model, embedding_updated_at)
                    VALUES (?, ?::FLOAT[1536], 'test-model', CURRENT_TIMESTAMP)`, ['aux-entity-high', highStr]);
    await conn.run(`INSERT OR REPLACE INTO entity_embeddings(name, embedding, embedding_model, embedding_updated_at)
                    VALUES (?, ?::FLOAT[1536], 'test-model', CURRENT_TIMESTAMP)`, ['aux-entity-low', lowStr]);
    // Optional: create index if available (ignore errors)
    try { await conn.run(`CREATE INDEX IF NOT EXISTS entity_embeddings_embedding_idx ON entity_embeddings USING HNSW (embedding)`); } catch {}
  });

  afterAll(async () => {
    await manager.close();
    delete (process.env as any).OPENAI_API_KEY;
    await cleanupTestDb(dbPath);
  });

  it('should have embeddings in aux table and join with entities', async () => {
    const conn = await (manager as any).getConnection();
    const countRows = await conn.runAndReadAll('SELECT COUNT(*) as c FROM entity_embeddings');
    const count = Array.isArray(countRows) ? countRows[0]?.c : countRows.getRows?.()[0]?.[0];
    expect(Number(count)).toBeGreaterThanOrEqual(2);

    const joinRows = await conn.runAndReadAll(`
      SELECT e.name
      FROM entities e JOIN entity_embeddings ee ON ee.name = e.name
      ORDER BY e.name
    `);
    const names = Array.isArray(joinRows)
      ? joinRows.map((r: any) => r.name)
      : joinRows.getRows?.().map((r: any[]) => r[0]);
    expect(names).toContain('aux-entity-high');
    expect(names).toContain('aux-entity-low');
  });
});


