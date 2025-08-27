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

describe("Chinese Search Detection", () => {
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

  describe("searchNodes with Chinese detection", () => {
    it("should use LIKE search when Chinese characters are detected", async () => {
      // Force a high entity count to ensure FTS would normally be used
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with Chinese query
      await manager.searchNodes("中文測試", { output: { compact: false, includeObservations: true } });
      
      // Verify that LIKE search was chosen due to Chinese detection
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Chinese detected: true")
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using LIKE search due to Chinese character detection"
      );
    });

    it("should use FTS search when no Chinese characters and entity count is high", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with English query
      await manager.searchNodes("english test", { output: { compact: false, includeObservations: true } });
      
      // Verify that FTS search was chosen
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Chinese detected: false")
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using FTS search for large dataset"
      );
    });

    it("should use LIKE search for mixed Chinese-English queries", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with mixed Chinese-English query
      await manager.searchNodes("中文 test entity", { output: { compact: false, includeObservations: true } });
      
      // Verify that LIKE search was chosen due to Chinese detection
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Chinese detected: true")
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using LIKE search due to Chinese character detection"
      );
    });

    it("should still use LIKE search for small datasets even without Chinese", async () => {
      // Force a low entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(500);
      
      // Search with English query
      await manager.searchNodes("english test", { output: { compact: false, includeObservations: true } });
      
      // Verify that LIKE search was chosen due to small dataset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Chinese detected: false")
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using LIKE search for small dataset"
      );
    });
  });

  describe("searchMultiKeywords with Chinese detection", () => {
    it("should use LIKE search when any keyword contains Chinese", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with keywords where one contains Chinese
      await manager.searchMultiKeywords(["test", "中文", "entity"], { 
        mode: "OR",
        output: { compact: false, includeObservations: true } 
      });
      
      // Verify that LIKE search was chosen due to Chinese detection
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Using LIKE search for multi-keyword search due to Chinese character detection")
      );
    });

    it("should use FTS search when no Chinese in any keyword and high entity count", async () => {
      // Force a high entity count
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with all English keywords
      await manager.searchMultiKeywords(["test", "english", "entity"], {
        mode: "OR", 
        output: { compact: false, includeObservations: true }
      });
      
      // Verify that FTS search was chosen
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Using FTS search for multi-keyword search")
      );
    });

    it("should use LIKE search for small datasets even without Chinese", async () => {
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

    it("should work with traditional Chinese characters", async () => {
      // Add entity with traditional Chinese
      await manager.createEntities([
        {
          name: "traditional_chinese_entity",
          entityType: "concept",
          observations: ["繁體中文測試內容", "傳統漢字"],
          createdAt: new Date().toISOString(),
        }
      ]);

      // Force high entity count to test Chinese detection override
      vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
      
      // Search with traditional Chinese
      const results = await manager.searchNodes("繁體", {
        output: { compact: false, includeObservations: true }
      });
      
      // Verify LIKE search was used
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Using LIKE search due to Chinese character detection"
      );
      
      // Should find the traditional Chinese entity among the results
      expect(results.entities.length).toBeGreaterThanOrEqual(1);
      const traditionalEntity = results.entities.find(e => e.name === "traditional_chinese_entity");
      expect(traditionalEntity).toBeDefined();
      expect(traditionalEntity?.name).toBe("traditional_chinese_entity");
    });
  });
});