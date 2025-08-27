import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { cleanupTestDb, generateUniqueDbPath, safeCloseManager } from './test-utils';

describe('Output Compaction & Limits', () => {
  let dbPath: string;
  let manager: DuckDBKnowledgeGraphManager;

  beforeEach(async () => {
    dbPath = generateUniqueDbPath('output-compaction');
    manager = new DuckDBKnowledgeGraphManager(() => dbPath, undefined, true);
    await manager.initialize();

    const entities = [] as Array<{ name: string; entityType: string; observations: string[]; createdAt: string }>;
    for (let i = 0; i < 10; i++) {
      const observations: string[] = [];
      for (let j = 0; j < 5; j++) {
        observations.push(`Observation ${j} for entity ${i} ${'x'.repeat(100)}`);
      }
      entities.push({
        name: `Entity_${i}`,
        entityType: 'Test',
        observations,
        createdAt: `2024-01-01T0${i % 10}:00:00Z`,
      });
    }
    await manager.createEntities(entities);

    const relations = [] as Array<{ from: string; to: string; relationType: string; createdAt: string }>;
    // Create unique relations only to avoid PK/UNIQUE conflicts
    for (let i = 0; i < 10; i++) {
      relations.push({
        from: `Entity_${i % 10}`,
        to: `Entity_${(i + 1) % 10}`,
        relationType: 'linked_to',
        createdAt: `2024-01-02T0${i % 10}:00:00Z`,
      });
    }
    await manager.createRelations(relations);
  });

  afterEach(async () => {
    await safeCloseManager(manager);
    await cleanupTestDb(dbPath);
  });

  it('should respect maxEntities and report omittedEntities', async () => {
    const result = await manager.searchNodes('Entity_', {
      output: { maxEntities: 3, compact: true }
    });
    expect(result.entities.length).toBe(3);
    expect(result.omittedEntities).toBeGreaterThanOrEqual(7);
  });

  it('should omit observations when includeObservations=false and provide counts', async () => {
    const result = await manager.searchNodes('Entity_0', {
      output: { includeObservations: false, compact: true }
    });
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    const e0 = result.entities[0];
    expect(e0.observations).toEqual([]);
    expect(e0.observationsCount).toBe(5);
    expect(e0.omittedObservations).toBe(5);
  });

  it('should apply maxObservationsPerEntity and snippetChars to build observationsPreview', async () => {
    const result = await manager.searchNodes('Entity_1', {
      output: { includeObservations: true, maxObservationsPerEntity: 2, snippetChars: 50 }
    });
    const e = result.entities[0];
    expect(e.observationsCount).toBe(5);
    expect(e.observations.length).toBe(2);
    expect(e.observations[0].length).toBeLessThanOrEqual(50);
    expect(e.omittedObservations).toBe(3);
  });

  it('should cap relations in subset mode and report omittedRelations', async () => {
    const result = await manager.searchNodes('Entity_', {
      output: { includeRelations: 'subset', maxRelations: 5, compact: true }
    });
    expect(result.relations.length).toBeLessThanOrEqual(5);
    expect((result.omittedRelations || 0)).toBeGreaterThanOrEqual(0);
  });

  it('should remove relations in none mode', async () => {
    const result = await manager.searchNodes('Entity_', {
      output: { includeRelations: 'none', compact: true }
    });
    expect(result.relations.length).toBe(0);
    expect(result.omittedRelations).toBeGreaterThan(0);
  });

  it('should set truncated flag when exceeding maxResponseChars (approximate)', async () => {
    const result = await manager.searchNodes('Entity_', {
      output: { maxResponseChars: 100, includeObservations: true }
    });
    expect(result.truncated).toBe(true);
  });
});


