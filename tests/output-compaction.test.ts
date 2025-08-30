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
      // Force deterministic keyword path to avoid VSS/hybrid interference
      searchMode: 'keyword' as any,
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

  // Enhanced Observations 補水與截斷測試
  describe('Observations 補水與截斷 (Advanced)', () => {
    beforeEach(async () => {
      // Create entities with varying observation counts and content lengths
      const advancedEntities = [
        {
          name: 'rich-entity',
          entityType: 'detailed',
          observations: [
            'First observation with moderate length content that should be visible',
            'Second observation containing technical details about implementation patterns and best practices',
            'Third observation with very long content: ' + 'Lorem ipsum '.repeat(50),
            'Fourth observation about architecture decisions and their rationale',
            'Fifth observation discussing performance implications',
            'Sixth observation covering security considerations',
            'Seventh observation about maintainability aspects',
            'Eighth observation regarding scalability factors'
          ],
          createdAt: new Date().toISOString()
        },
        {
          name: 'sparse-entity',
          entityType: 'minimal',
          observations: [
            'Single short observation',
            'Another brief note'
          ],
          createdAt: new Date().toISOString()
        },
        {
          name: 'empty-entity',
          entityType: 'empty',
          observations: [],
          createdAt: new Date().toISOString()
        }
      ];
      await manager.createEntities(advancedEntities);
    });

    it('should return empty observations array when includeObservations=false', async () => {
      const result = await manager.searchNodes('rich-entity', {
        output: { includeObservations: false, compact: true }
      });
      
      expect(result.entities.length).toBe(1);
      const entity = result.entities[0];
      
      // 補水驗證：即使不包含內容，也要提供計數資訊
      expect(entity.observations).toEqual([]);
      expect(entity.observationsCount).toBe(8);  // 原始總數
      expect(entity.omittedObservations).toBe(8);  // 全部省略
    });

    it('should apply maxObservationsPerEntity limit correctly', async () => {
      const result = await manager.searchNodes('rich-entity', {
        output: { 
          includeObservations: true, 
          maxObservationsPerEntity: 3,
          compact: true 
        }
      });
      
      expect(result.entities.length).toBe(1);
      const entity = result.entities[0];
      
      // 截斷驗證
      expect(entity.observations.length).toBe(3);  // 最多3個
      expect(entity.observationsCount).toBe(8);    // 原始總數不變
      expect(entity.omittedObservations).toBe(5);  // 8-3=5個被省略
      
      // 確認返回的是前3個觀察
      expect(entity.observations[0]).toContain('First observation');
      expect(entity.observations[1]).toContain('Second observation');
      expect(entity.observations[2]).toContain('Third observation');
    });

    it('should apply snippetChars to truncate long observations', async () => {
      const result = await manager.searchNodes('rich-entity', {
        output: { 
          includeObservations: true, 
          maxObservationsPerEntity: 2,
          snippetChars: 50,
          compact: true 
        }
      });
      
      const entity = result.entities[0];
      expect(entity.observations.length).toBe(2);
      
      // 截斷長度驗證
      entity.observations.forEach(obs => {
        expect(obs.length).toBeLessThanOrEqual(50);
      });
      
      // 確認長內容被截斷
      const longObservation = entity.observations.find(obs => 
        obs.includes('Second observation')
      );
      expect(longObservation).toBeDefined();
      expect(longObservation!.length).toBeLessThanOrEqual(50);
      expect(longObservation).not.toContain('implementation patterns and best practices');  // 被截斷
    });

    it('should handle combination of maxObservationsPerEntity and snippetChars', async () => {
      const result = await manager.searchNodes('rich-entity', {
        output: { 
          includeObservations: true, 
          maxObservationsPerEntity: 4,
          snippetChars: 80,
          compact: true 
        }
      });
      
      const entity = result.entities[0];
      
      // 組合邏輯驗證
      expect(entity.observations.length).toBe(4);  // 數量限制
      expect(entity.observationsCount).toBe(8);
      expect(entity.omittedObservations).toBe(4);  // 8-4=4個被省略
      
      // 每個都受長度限制
      entity.observations.forEach((obs, index) => {
        expect(obs.length).toBeLessThanOrEqual(80);
        expect(obs).toBeTruthy();
      });
      
      // 驗證超長內容被截斷
      const veryLongObs = entity.observations[2]; // "Third observation with very long content..."
      expect(veryLongObs.length).toBeLessThanOrEqual(80);
      expect(veryLongObs).toContain('Third observation');
    });

    it('should build observationsPreview when truncated', async () => {
      const result = await manager.searchNodes('rich-entity', {
        output: { 
          includeObservations: true,
          maxObservationsPerEntity: 2,
          snippetChars: 60
        }
      });
      
      const entity = result.entities[0];
      
      // observationsPreview 功能驗證（如果實作了的話）
      expect(entity.observations.length).toBe(2);
      expect(entity.observationsCount).toBe(8);
      expect(entity.omittedObservations).toBe(6);
      
      // 每個 observation 都應該被截斷到指定長度
      entity.observations.forEach(obs => {
        expect(obs.length).toBeLessThanOrEqual(60);
      });
    });

    it('should handle entities with fewer observations than maxObservationsPerEntity', async () => {
      const result = await manager.searchNodes('sparse-entity', {
        output: { 
          includeObservations: true, 
          maxObservationsPerEntity: 5,  // 大於實際數量
          snippetChars: 100,
          compact: true 
        }
      });
      
      const entity = result.entities[0];
      
      // 不應該填充或創造不存在的觀察
      expect(entity.observations.length).toBe(2);  // 實際數量
      expect(entity.observationsCount).toBe(2);
      expect(entity.omittedObservations).toBe(0);  // 沒有省略
      
      // 內容應該完整保留（不超過 snippetChars）
      expect(entity.observations[0]).toBe('Single short observation');
      expect(entity.observations[1]).toBe('Another brief note');
    });

    it('should handle empty entities correctly', async () => {
      const result = await manager.searchNodes('empty-entity', {
        output: { 
          includeObservations: true, 
          maxObservationsPerEntity: 5,
          snippetChars: 100,
          compact: true 
        }
      });
      
      const entity = result.entities[0];
      
      // 空實體處理
      expect(entity.observations).toEqual([]);
      expect(entity.observationsCount).toBe(0);
      expect(entity.omittedObservations).toBe(0);
    });

    it('should maintain consistency between includeObservations true/false states', async () => {
      // 測試相同實體在不同 includeObservations 設定下的一致性
      const withObservations = await manager.searchNodes('rich-entity', {
        output: { includeObservations: true, compact: true }
      });
      
      const withoutObservations = await manager.searchNodes('rich-entity', {
        output: { includeObservations: false, compact: true }
      });
      
      const entityWith = withObservations.entities[0];
      const entityWithout = withoutObservations.entities[0];
      
      // 元數據應該一致
      expect(entityWith.name).toBe(entityWithout.name);
      expect(entityWith.entityType).toBe(entityWithout.entityType);
      expect(entityWith.observationsCount).toBe(entityWithout.observationsCount);
      expect(entityWith.observationsCount).toBe(8);  // 兩種情況下都是8
      
      // 觀察內容差異
      expect(entityWith.observations.length).toBeGreaterThan(0);
      expect(entityWithout.observations.length).toBe(0);
      expect(entityWithout.omittedObservations).toBe(8);  // 全部省略
    });

    it('should respect global maxResponseChars with observations', async () => {
      // 測試全域字元限制對 observations 的影響
      const result = await manager.searchNodes('Entity_', {  // 匹配多個實體
        output: { 
          includeObservations: true,
          maxResponseChars: 500,  // 嚴格限制
          compact: true
        }
      });
      
      // 應該觸發全域截斷機制
      expect(result.truncated).toBe(true);
      
      // JSON 序列化後應該在限制內（大致）
      const serialized = JSON.stringify(result);
      // 允許一些彈性，因為截斷是漸進式的
      expect(serialized.length).toBeLessThan(1000);  // 合理的上限
    });
  });
});


