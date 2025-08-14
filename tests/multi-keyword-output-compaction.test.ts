import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { cleanupTestDb, generateUniqueDbPath, safeCloseManager } from './test-utils';

describe('MultiKeyword Output Compaction & Limits', () => {
  let dbPath: string;
  let manager: DuckDBKnowledgeGraphManager;

  beforeEach(async () => {
    dbPath = generateUniqueDbPath('multi-keyword-output');
    manager = new DuckDBKnowledgeGraphManager(() => dbPath, undefined, true);
    await manager.initialize();

    const entities = [] as Array<{ name: string; entityType: string; observations: string[]; createdAt: string }>;
    for (let i = 0; i < 10; i++) {
      const observations: string[] = [];
      for (let j = 0; j < 5; j++) {
        observations.push(`Observation ${j} for entity ${i} ${'y'.repeat(100)}`);
      }
      entities.push({
        name: `Entity_${i}`,
        entityType: 'Test',
        observations,
        createdAt: `2024-02-01T0${i % 10}:00:00Z`,
      });
    }
    await manager.createEntities(entities);
  });

  afterEach(async () => {
    await safeCloseManager(manager);
    await cleanupTestDb(dbPath);
  });

  it('should omit observations with includeObservations=false and provide counts (multi-keyword)', async () => {
    const result = await manager.searchMultiKeywords(['Entity', 'Observation'], {
      output: { includeObservations: false, compact: true, maxEntities: 3 }
    });
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    const e0 = result.entities[0];
    expect(Array.isArray(e0.observations)).toBe(true);
    expect(e0.observations).toEqual([]);
    expect(e0.observationsCount).toBe(5);
    expect(e0.omittedObservations).toBe(5);
  });

  it('should set truncated flag when exceeding maxResponseChars (multi-keyword)', async () => {
    const result = await manager.searchMultiKeywords(['Entity'], {
      output: { maxResponseChars: 100, includeObservations: true }
    });
    expect(result.truncated).toBe(true);
  });
});


