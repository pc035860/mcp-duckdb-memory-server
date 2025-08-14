import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { cleanupTestDb, generateUniqueDbPath, safeCloseManager } from './test-utils';

describe('open_nodes includeObservations behavior', () => {
  let dbPath: string;
  let manager: DuckDBKnowledgeGraphManager;

  beforeEach(async () => {
    dbPath = generateUniqueDbPath('open-nodes');
    manager = new DuckDBKnowledgeGraphManager(() => dbPath, undefined, true);
    await manager.initialize();

    const entities = [
      {
        name: 'Node_A',
        entityType: 'Test',
        observations: [
          'This is a long observation A ' + 'z'.repeat(200),
          'This is a long observation B ' + 'z'.repeat(200),
        ],
        createdAt: '2024-03-01T00:00:00Z',
      },
    ];

    await manager.createEntities(entities);
  });

  afterEach(async () => {
    await safeCloseManager(manager);
    await cleanupTestDb(dbPath);
  });

  it('returns observations by default (backward compatible)', async () => {
    const result = await manager.openNodes(['Node_A']);
    expect(result.entities.length).toBe(1);
    const e = result.entities[0];
    expect(e.name).toBe('Node_A');
    expect(e.observations.length).toBeGreaterThanOrEqual(1);
  });

  it('omits observations when includeObservations=false', async () => {
    const result = await manager.openNodes(['Node_A'], { includeObservations: false });
    expect(result.entities.length).toBe(1);
    const e = result.entities[0];
    expect(e.observations).toEqual([]);
  });
});


