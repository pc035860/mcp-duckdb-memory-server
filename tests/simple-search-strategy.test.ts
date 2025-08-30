import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager";

// Mock the logger to capture debug messages
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("Simple Search Strategy Test", () => {
  let manager: DuckDBKnowledgeGraphManager;
  
  beforeEach(async () => {
    // Create manager with in-memory database and mocked logger
    manager = new DuckDBKnowledgeGraphManager(() => ":memory:", mockLogger as any);
    await manager.initialize();
    
    // Clear mock calls before each test
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
    }
  });

  it("should use traditional search (no hybrid) with dataset size logic", async () => {
    // Test small dataset - should use LIKE
    vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(500);
    
    // Call performTraditionalSearch directly through the manager's search method with keyword mode
    await manager.searchNodes("test query", { 
      searchMode: "keyword" as any,
      output: { compact: false, includeObservations: true } 
    });
    
    // Verify that LIKE search was chosen for small dataset
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "Using LIKE search for small dataset"
    );
    
    // Clear mocks and test large dataset - should use FTS
    vi.clearAllMocks();
    vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
    
    await manager.searchNodes("test query", { 
      searchMode: "keyword" as any,
      output: { compact: false, includeObservations: true } 
    });
    
    // Verify that FTS search was chosen for large dataset
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "Using FTS search for large dataset"
    );
  });

  it("should use traditional search with Chinese query - no special handling", async () => {
    // Test Chinese query with large dataset - should use FTS (not LIKE due to Chinese)
    vi.spyOn(manager as any, 'getCachedEntityCount').mockResolvedValue(2000);
    
    await manager.searchNodes("中文測試", { 
      searchMode: "keyword" as any,
      output: { compact: false, includeObservations: true } 
    });
    
    // Verify that FTS search was chosen (no Chinese detection override)
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "Using FTS search for large dataset"
    );
  });
});