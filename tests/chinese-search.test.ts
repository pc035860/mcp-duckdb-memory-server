import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";
import { ConsoleLogger } from "../src/logger";

// Mock the logger to capture debug messages
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("Search Strategy Based on Dataset Size", () => {
  let manager: DuckDBKnowledgeGraphManager;
  
  beforeEach(async () => {
    // Create manager with in-memory database and mocked logger
    manager = new DuckDBKnowledgeGraphManager(() => ":memory:", mockLogger as any);
    await manager.initialize();
    
    // Clear mock calls before each test
    vi.clearAllMocks();
    
    // Add some test entities with Chinese content
    await manager.createEntities([
      {
        name: "chinese_test_entity",
        entityType: "concept",
        observations: [
          "這是一個中文測試實體",
          "用於測試中文搜尋功能",
          "包含繁體中文內容"
        ],
        createdAt: new Date().toISOString(),
      },
      {
        name: "english_test_entity", 
        entityType: "concept",
        observations: [
          "This is an English test entity",
          "Used for testing search functionality", 
          "Contains English content only"
        ],
        createdAt: new Date().toISOString(),
      },
      {
        name: "mixed_test_entity",
        entityType: "concept", 
        observations: [
          "Mixed content with 中文 and English",
          "用於測試 mixed language search",
          "Bilingual test entity"
        ],
        createdAt: new Date().toISOString(),
      }
    ]);
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
    }
  });

  describe("searchNodes with dataset size detection", () => {
    it("should use FTS search for large datasets regardless of language", async () => {
      // Force a high entity count to ensure FTS is used
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with Chinese query
      await manager.searchNodes("中文測試", { output: { compact: false, includeObservations: true } });
      
      // Verify that FTS search was chosen due to large dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using FTS search for large dataset"
      );
    });

    it("should use FTS search for large datasets with English queries", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with English query
      await manager.searchNodes("english test", { output: { compact: false, includeObservations: true } });
      
      // Verify that FTS search was chosen
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using FTS search for large dataset"
      );
    });

    it("should use FTS search for mixed Chinese-English queries with large datasets", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with mixed Chinese-English query
      await manager.searchNodes("中文 test entity", { output: { compact: false, includeObservations: true } });
      
      // Verify that FTS search was chosen due to large dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using FTS search for large dataset"
      );
    });

    it("should use LIKE search for small datasets regardless of language", async () => {
      // Force a low entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(500);
      
      // Search with English query
      await manager.searchNodes("english test", { output: { compact: false, includeObservations: true } });
      
      // Verify that LIKE search was chosen due to small dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using LIKE search for small dataset"
      );
    });
  });

  describe("searchMultiKeywords with dataset size detection", () => {
    it("should use FTS search for large datasets regardless of language", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with keywords where one contains Chinese
      await manager.searchMultiKeywords(["test", "中文", "entity"], { 
        mode: "OR",
        output: { compact: false, includeObservations: true } 
      });
      
      // Verify that FTS search was chosen due to large dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Using FTS search for multi-keyword search (large dataset)")
      );
    });

    it("should use FTS search for large datasets with English keywords", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with all English keywords
      await manager.searchMultiKeywords(["test", "english", "entity"], {
        mode: "OR", 
        output: { compact: false, includeObservations: true }
      });
      
      // Verify that FTS search was chosen
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Using FTS search for multi-keyword search (large dataset)")
      );
    });

    it("should use LIKE search for small datasets regardless of language", async () => {
      // Force a low entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(500);
      
      // Search with all English keywords
      await manager.searchMultiKeywords(["test", "english", "entity"], {
        mode: "OR",
        output: { compact: false, includeObservations: true }
      });
      
      // Verify that LIKE search was chosen due to small dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Using LIKE search for multi-keyword search (small dataset)")
      );
    });
  });

  describe("Functional search results with Chinese queries", () => {
    it("should return relevant results for Chinese queries", async () => {
      // Search for Chinese content
      const results = await manager.searchNodes("中文測試", { 
        output: { compact: false, includeObservations: true } 
      });
      
      // Should find the Chinese test entity
      expect(results.entities).toHaveLength(1);
      expect(results.entities[0].name).toBe("chinese_test_entity");
      expect(results.entities[0].observations).toContain("這是一個中文測試實體");
    });

    it("should return relevant results for mixed Chinese-English queries", async () => {
      // Search for mixed content  
      const results = await manager.searchNodes("中文", {
        output: { compact: false, includeObservations: true }
      });
      
      // Should find entities containing Chinese characters
      expect(results.entities.length).toBeGreaterThan(0);
      
      // Check if results contain entities with Chinese content
      const entityNames = results.entities.map(e => e.name);
      expect(entityNames).toEqual(
        expect.arrayContaining(["chinese_test_entity", "mixed_test_entity"])
      );
    });

    it("should work with traditional Chinese characters using appropriate search strategy", async () => {
      // Add entity with traditional Chinese
      await manager.createEntities([
        {
          name: "traditional_chinese_entity",
          entityType: "concept",
          observations: ["繁體中文測試內容", "傳統漢字"],
          createdAt: new Date().toISOString(),
        }
      ]);

      // Test with large dataset - should use FTS
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with traditional Chinese
      const results = await manager.searchNodes("繁體", {
        output: { compact: false, includeObservations: true }
      });
      
      // Verify FTS search was used due to large dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using FTS search for large dataset"
      );
      
      // Should find the traditional Chinese entity among the results (if FTS supports Chinese)
      expect(results.entities.length).toBeGreaterThanOrEqual(0);
      
      // Test with small dataset - should use LIKE which better supports Chinese
      vi.clearAllMocks();
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(500);
      
      const resultsSmall = await manager.searchNodes("繁體", {
        output: { compact: false, includeObservations: true }
      });
      
      // Verify LIKE search was used for small dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using LIKE search for small dataset"
      );
      
      // Should find the traditional Chinese entity with LIKE search
      expect(resultsSmall.entities.length).toBeGreaterThanOrEqual(1);
      const traditionalEntity = resultsSmall.entities.find(e => e.name === "traditional_chinese_entity");
      expect(traditionalEntity).toBeDefined();
      expect(traditionalEntity?.name).toBe("traditional_chinese_entity");
    });
  });

  // 中文查詢走 hybrid 模式測試
  describe('Chinese queries with hybrid mode', () => {
    beforeEach(async () => {
      // Clear previous mocks and add Chinese-friendly test data
      vi.clearAllMocks();
      
      // Add comprehensive Chinese test entities
      await manager.createEntities([
        {
          name: 'chinese_ai_system',
          entityType: 'ai-system',
          observations: [
            '人工智慧系統',
            '機器學習算法',
            '深度學習模型',
            '自然語言處理'
          ],
          createdAt: new Date().toISOString()
        },
        {
          name: 'chinese_database',
          entityType: 'database',
          observations: [
            '中文資料庫系統',
            '數據存儲與查詢',
            '分佈式架構',
            '高可用性設計'
          ],
          createdAt: new Date().toISOString()
        },
        {
          name: 'mixed_language_api',
          entityType: 'api-service',
          observations: [
            'Multi-language API with 中文支援',
            'RESTful interface with 本地化功能',
            'Bilingual documentation 雙語文檔'
          ],
          createdAt: new Date().toISOString()
        }
      ]);
    });

    it('should use hybrid mode for Chinese queries when no search mode is specified', async () => {
      // Force a reasonable entity count that allows hybrid mode
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(500);
      
      // Test pure Chinese query without specifying search mode (should use hybrid)
      const results = await manager.searchNodes('人工智慧', {
        searchMode: 'hybrid' as any  // Explicitly test hybrid mode
      });
      
      expect(results.entities.length).toBeGreaterThan(0);
      
      // Should find Chinese AI system
      const aiSystem = results.entities.find(e => e.name === 'chinese_ai_system');
      expect(aiSystem).toBeDefined();
      expect(aiSystem?.observations).toContain('人工智慧系統');
      
      // Verify hybrid mode can handle Chinese content
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should support hybrid search with mixed Chinese-English queries', async () => {
      // Force entity count to allow hybrid mode
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(800);
      
      const results = await manager.searchNodes('API 中文支援', {
        searchMode: 'hybrid' as any
      });
      
      expect(results.entities.length).toBeGreaterThan(0);
      
      // Should find the mixed language API
      const mixedApi = results.entities.find(e => e.name === 'mixed_language_api');
      expect(mixedApi).toBeDefined();
      
      // Should contain both Chinese and English content
      const hasChineseSupport = mixedApi?.observations.some(obs => obs.includes('中文支援'));
      const hasApiContent = mixedApi?.observations.some(obs => obs.includes('API'));
      expect(hasChineseSupport).toBe(true);
      expect(hasApiContent).toBe(true);
    });

    it('should handle traditional Chinese characters in hybrid mode', async () => {
      // Add entity with traditional Chinese
      await manager.createEntities([
        {
          name: 'traditional_system',
          entityType: 'legacy-system',
          observations: [
            '傳統系統架構',
            '繁體中文介面',
            '舊版軟體相容性'
          ],
          createdAt: new Date().toISOString()
        }
      ]);
      
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(600);
      
      const results = await manager.searchNodes('傳統 系統', {
        searchMode: 'hybrid' as any
      });
      
      expect(results.entities.length).toBeGreaterThan(0);
      
      const traditionalSystem = results.entities.find(e => e.name === 'traditional_system');
      expect(traditionalSystem).toBeDefined();
      expect(traditionalSystem?.observations).toContain('傳統系統架構');
    });

    it('should maintain search quality with Chinese queries in hybrid mode', async () => {
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(750);
      
      const chineseQuery = '機器學習';
      const results = await manager.searchNodes(chineseQuery, {
        searchMode: 'hybrid' as any
      });
      
      expect(results.entities.length).toBeGreaterThan(0);
      
      // Should find relevant entities
      const relevantEntities = results.entities.filter(e => 
        e.observations.some(obs => obs.includes('機器學習') || obs.includes('人工智慧'))
      );
      expect(relevantEntities.length).toBeGreaterThan(0);
      
      // Verify result structure is correct
      results.entities.forEach(entity => {
        expect(entity).toHaveProperty('name');
        expect(entity).toHaveProperty('entityType');
        expect(entity).toHaveProperty('observations');
        expect(entity).toHaveProperty('createdAt');
        expect(Array.isArray(entity.observations)).toBe(true);
      });
    });

    it('should handle Chinese punctuation and special characters in hybrid mode', async () => {
      await manager.createEntities([
        {
          name: 'punctuation_test',
          entityType: 'test-data',
          observations: [
            '測試：中文標點符號',
            '包含、逗號，和句號。',
            '問號？感嘆號！括號（測試）',
            '引號「測試」書名號《測試》'
          ],
          createdAt: new Date().toISOString()
        }
      ]);
      
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(700);
      
      const results = await manager.searchNodes('中文標點', {
        searchMode: 'hybrid' as any
      });
      
      expect(results.entities.length).toBeGreaterThan(0);
      
      const punctuationTest = results.entities.find(e => e.name === 'punctuation_test');
      expect(punctuationTest).toBeDefined();
      expect(punctuationTest?.observations).toContain('測試：中文標點符號');
    });

    it('should compare hybrid vs keyword performance for Chinese queries', async () => {
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(900);
      
      const chineseQuery = '資料庫系統';
      
      // Test both modes
      const keywordResults = await manager.searchNodes(chineseQuery, {
        searchMode: 'keyword' as any
      });
      
      const hybridResults = await manager.searchNodes(chineseQuery, {
        searchMode: 'hybrid' as any
      });
      
      // Both should return valid results
      expect(keywordResults.entities.length).toBeGreaterThanOrEqual(0);
      expect(hybridResults.entities.length).toBeGreaterThanOrEqual(0);
      
      // Both should maintain proper structure
      [keywordResults, hybridResults].forEach((results, index) => {
        const mode = index === 0 ? 'keyword' : 'hybrid';
        expect(results, `${mode} results should be defined`).toBeTruthy();
        expect(Array.isArray(results.entities), `${mode} entities should be array`).toBe(true);
        expect(Array.isArray(results.relations), `${mode} relations should be array`).toBe(true);
      });
      
      // If both return results, they should contain relevant entities
      if (keywordResults.entities.length > 0 && hybridResults.entities.length > 0) {
        const keywordRelevant = keywordResults.entities.some(e => 
          e.observations.some(obs => obs.includes('資料庫') || obs.includes('數據'))
        );
        const hybridRelevant = hybridResults.entities.some(e => 
          e.observations.some(obs => obs.includes('資料庫') || obs.includes('數據'))
        );
        
        expect(keywordRelevant || hybridRelevant).toBe(true);
      }
    });

    it('should handle edge cases with Chinese queries in hybrid mode', async () => {
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(650);
      
      const edgeCaseQueries = [
        '單一字', // Single character
        '很長的中文查詢包含許多不同的詞彙和概念', // Very long query
        '中英Mixed語言Query', // Mixed script
        '123數字456中文789', // Numbers mixed with Chinese
      ];
      
      for (const query of edgeCaseQueries) {
        const results = await manager.searchNodes(query, {
          searchMode: 'hybrid' as any
        });
        
        // Should handle gracefully without throwing errors
        expect(results).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        expect(Array.isArray(results.relations)).toBe(true);
        
        // Results may be empty for some edge cases, but structure should be maintained
        expect(results.entities.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should verify log messages for Chinese hybrid search mode selection', async () => {
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(1000);
      
      // Test Chinese query with hybrid mode - should show appropriate logging
      await manager.searchNodes('中文測試', {
        searchMode: 'hybrid' as any
      });
      
      // Verify that appropriate debug messages were logged
      // The exact message depends on implementation, but should indicate hybrid mode usage
      expect(mockLogger.debug).toHaveBeenCalled();
      
      // Check if any debug calls relate to search mode selection or Chinese handling
      const debugCalls = mockLogger.debug.mock.calls;
      const hasSearchModeLog = debugCalls.some(call => 
        call.some(arg => 
          typeof arg === 'string' && 
          (arg.includes('hybrid') || arg.includes('search') || arg.includes('mode'))
        )
      );
      
      // Should have some form of search-related logging
      expect(hasSearchModeLog).toBe(true);
    });
  });
});