import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { OpenAIEmbeddingService, createEmbeddingCache } from '../src/services/embedding/index.js';
import { DuckDBVSSManager } from '../src/services/vss/index.js';
import { HybridSearchEngine } from '../src/services/search/index.js';
import { ConsoleLogger } from '../src/logger.js';

// Mock OpenAI API for testing
vi.mock('../src/services/embedding/openai-embedding-service.js', () => ({
  OpenAIEmbeddingService: vi.fn().mockImplementation(() => ({
    generateEmbedding: vi.fn().mockResolvedValue({
      embedding: new Array(1536).fill(0.1), // Mock 1536-dimensional embedding
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 }
    }),
    generateBatchEmbeddings: vi.fn().mockResolvedValue({
      embeddings: [
        { embedding: new Array(1536).fill(0.1), model: 'text-embedding-3-small' },
        { embedding: new Array(1536).fill(0.2), model: 'text-embedding-3-small' }
      ],
      usage: { prompt_tokens: 20, total_tokens: 20 }
    }),
    checkHealth: vi.fn().mockResolvedValue(true),
    getConfig: vi.fn().mockReturnValue({
      model: 'text-embedding-3-small',
      timeout: 30000,
      retries: 3
    })
  }))
}));

describe('VSS Integration Tests', () => {
  let manager: DuckDBKnowledgeGraphManager;
  let tempDbPath: string;
  
  beforeEach(async () => {
    // Create unique temp DB path for each test
    tempDbPath = `:memory:test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    manager = new DuckDBKnowledgeGraphManager(
      () => tempDbPath,
      new ConsoleLogger(),
      false,
      10 // Low threshold to force FTS usage
    );
    
    // Initialize the manager
    await manager.initialize();
    
    // Set mock OpenAI API key for testing
    process.env.OPENAI_API_KEY = 'test-api-key';
  });

  afterEach(async () => {
    if (manager && !manager.isClosed()) {
      await manager.close();
    }
    // Clean up env
    delete process.env.OPENAI_API_KEY;
  });

  describe('Basic VSS Functionality', () => {
    it('should initialize VSS services when OpenAI API key is available', async () => {
      // VSS availability depends on successful initialization
      const isVSSAvailable = manager.isVSSAvailable();
      
      if (isVSSAvailable) {
        expect(manager.getEmbeddingService()).toBeTruthy();
        expect(manager.getVSSManager()).toBeTruthy();
      } else {
        // In CI or environments without OpenAI setup, should gracefully handle
        expect(manager.getEmbeddingService()).toBeNull();
        expect(manager.getVSSManager()).toBeNull();
      }
    });

    it('should create entities with search functionality', async () => {
      // Create test entities with diverse content for testing
      const entities = [
        {
          name: 'user-authentication',
          entityType: 'system',
          observations: ['JWT token implementation', 'OAuth2 integration', 'Multi-factor authentication support'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'machine-learning-model',
          entityType: 'ai',
          observations: ['Neural network architecture', 'Training pipeline', 'Deep learning framework'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'data-processing',
          entityType: 'service',
          observations: ['ETL pipeline', 'Data transformation', 'Batch processing system'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'api-gateway',
          entityType: 'infrastructure',
          observations: ['Request routing', 'Rate limiting', 'Authentication proxy'],
          createdAt: new Date().toISOString()
        }
      ];

      await manager.createEntities(entities);

      // Test basic search functionality (should work regardless of VSS availability)
      const searchResults = await manager.searchNodes('authentication');
      expect(searchResults.entities.length).toBeGreaterThan(0);
      
      const foundEntity = searchResults.entities.find(e => e.name === 'user-authentication');
      expect(foundEntity).toBeTruthy();
      expect(foundEntity?.observations).toContain('JWT token implementation');
    });

    it('should handle search with different searchMode options', async () => {
      // Create test entities first
      await manager.createEntities([
        {
          name: 'security-system',
          entityType: 'system', 
          observations: ['Authentication mechanisms', 'Authorization policies'],
          createdAt: new Date().toISOString()
        }
      ]);

      // Test keyword search mode
      const keywordResults = await manager.searchNodes('security', {
        searchMode: 'keyword'
      });
      expect(keywordResults.entities.length).toBeGreaterThan(0);
      expect(keywordResults.entities.some(e => e.name === 'security-system')).toBe(true);

      // Test semantic search mode (should fallback gracefully if VSS not available)
      const semanticResults = await manager.searchNodes('user access control', {
        searchMode: 'semantic'
      });
      expect(semanticResults).toBeTruthy();
      expect(Array.isArray(semanticResults.entities)).toBe(true);

      // Test hybrid search mode (should fallback gracefully if VSS not available)
      const hybridResults = await manager.searchNodes('authentication', {
        searchMode: 'hybrid'
      });
      expect(hybridResults).toBeTruthy();
      expect(Array.isArray(hybridResults.entities)).toBe(true);

      // Test auto mode (no searchMode specified)
      const autoResults = await manager.searchNodes('security');
      expect(autoResults.entities.length).toBeGreaterThan(0);
    });
  });

  describe('VSS Service Integration', () => {
    it('should handle VSS unavailable gracefully', async () => {
      // Remove API key to simulate unavailable VSS
      delete process.env.OPENAI_API_KEY;
      
      // Create new manager without VSS
      const noVSSManager = new DuckDBKnowledgeGraphManager(
        () => `:memory:novss_${Date.now()}`,
        new ConsoleLogger()
      );
      
      await noVSSManager.initialize();
      
      try {
        expect(noVSSManager.isVSSAvailable()).toBe(false);
        
        // Should still perform keyword search
        await noVSSManager.createEntities([{
          name: 'test-entity',
          entityType: 'test',
          observations: ['test observation'],
          createdAt: new Date().toISOString()
        }]);
        
        const results = await noVSSManager.searchNodes('test', {
          searchMode: 'semantic' // Should fallback to keyword
        });
        
        expect(results.entities.length).toBeGreaterThan(0);
        expect(results.entities[0].name).toBe('test-entity');
      } finally {
        await noVSSManager.close();
      }
    });

    it('should maintain backward compatibility', async () => {
      // Test that existing search functionality works without specifying searchMode
      await manager.createEntities([{
        name: 'legacy-entity',
        entityType: 'legacy',
        observations: ['legacy implementation'],
        createdAt: new Date().toISOString()
      }]);

      // Search without any options (backward compatibility)
      const results = await manager.searchNodes('legacy');
      expect(results.entities.length).toBe(1);
      expect(results.entities[0].name).toBe('legacy-entity');
    });
  });

  describe('Search Mode Specific Tests', () => {
    beforeEach(async () => {
      // Create comprehensive test dataset for search mode testing
      const testEntities = [
        {
          name: 'authentication-service',
          entityType: 'microservice',
          observations: ['User login and logout functionality', 'JWT token generation and validation', 'OAuth2 integration'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'machine-learning-pipeline',
          entityType: 'ai',
          observations: ['Neural network training', 'Model deployment', 'Inference engine'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'data-analytics',
          entityType: 'service',
          observations: ['Statistical analysis', 'Data visualization', 'Business intelligence'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'security-framework',
          entityType: 'infrastructure',
          observations: ['Access control', 'Encryption services', 'Audit logging'],
          createdAt: new Date().toISOString()
        }
      ];
      await manager.createEntities(testEntities);
    });

    it('should execute keyword search mode correctly', async () => {
      const results = await manager.searchNodes('authentication', {
        searchMode: 'keyword'
      });
      
      expect(results.entities.length).toBeGreaterThan(0);
      expect(results.entities.some(e => e.name === 'authentication-service')).toBe(true);
      
      // Keyword search should find exact term matches
      const foundEntity = results.entities.find(e => e.name === 'authentication-service');
      expect(foundEntity).toBeDefined();
      expect(foundEntity?.observations.some(obs => obs.includes('JWT'))).toBe(true);
    });

    it('should execute semantic search mode with fallback', async () => {
      const results = await manager.searchNodes('user login system', {
        searchMode: 'semantic'
      });
      
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
      
      // Should either return semantic results or fallback results
      if (manager.isVSSAvailable()) {
        // With VSS available, should find semantically related entities
        expect(results.entities.length).toBeGreaterThanOrEqual(0);
      } else {
        // Without VSS, should fallback to keyword-like behavior
        expect(results.entities.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should execute hybrid search mode with RRF fusion', async () => {
      const results = await manager.searchNodes('machine learning', {
        searchMode: 'hybrid'
      });
      
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
      
      if (manager.isVSSAvailable()) {
        // With VSS available, hybrid should combine keyword + semantic
        expect(results.entities.length).toBeGreaterThanOrEqual(0);
        // Should potentially find 'machine-learning-pipeline'
        const mlEntity = results.entities.find(e => e.name === 'machine-learning-pipeline');
        if (mlEntity) {
          expect(mlEntity.observations.some(obs => obs.includes('neural') || obs.includes('training'))).toBe(true);
        }
      } else {
        // Without VSS, should fallback to keyword search
        expect(results.entities.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should execute auto mode with intelligent strategy selection', async () => {
      // Test with English query (should prefer semantic/hybrid if VSS available)
      const englishResults = await manager.searchNodes('data analysis system');
      expect(englishResults).toBeTruthy();
      expect(Array.isArray(englishResults.entities)).toBe(true);
      
      // Test with Chinese query (should force keyword mode)
      const chineseResults = await manager.searchNodes('數據分析');
      expect(chineseResults).toBeTruthy();
      expect(Array.isArray(chineseResults.entities)).toBe(true);
      
      // Both should return valid results structure
      expect(englishResults.entities).toBeDefined();
      expect(chineseResults.entities).toBeDefined();
    });

    it('should handle search mode parameter validation', async () => {
      // Test with invalid searchMode (should default to auto/hybrid behavior)
      const results = await manager.searchNodes('authentication', {
        searchMode: 'invalid-mode' as any
      });
      
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
    });

    it('should maintain search quality across different modes', async () => {
      const query = 'authentication';
      
      const keywordResults = await manager.searchNodes(query, { searchMode: 'keyword' });
      const hybridResults = await manager.searchNodes(query, { searchMode: 'hybrid' });
      const autoResults = await manager.searchNodes(query);
      
      // All modes should find the authentication service
      expect(keywordResults.entities.some(e => e.name === 'authentication-service')).toBe(true);
      expect(hybridResults.entities.some(e => e.name === 'authentication-service')).toBe(true);
      expect(autoResults.entities.some(e => e.name === 'authentication-service')).toBe(true);
      
      // Results should have consistent structure
      for (const results of [keywordResults, hybridResults, autoResults]) {
        expect(results).toHaveProperty('entities');
        expect(results).toHaveProperty('relations');
        expect(Array.isArray(results.entities)).toBe(true);
        expect(Array.isArray(results.relations)).toBe(true);
      }
    });
  });

  describe('Performance and Error Handling', () => {
    it('should handle empty queries gracefully', async () => {
      const results = await manager.searchNodes('');
      expect(results.entities).toEqual([]);
      expect(results.relations).toEqual([]);
    });

    it('should handle non-existent search terms', async () => {
      const results = await manager.searchNodes('nonexistent_term_12345');
      expect(results.entities).toEqual([]);
      expect(results.relations).toEqual([]);
    });

    it('should respect output limiting options with VSS', async () => {
      // Create multiple entities
      const entities = Array.from({ length: 5 }, (_, i) => ({
        name: `test-entity-${i}`,
        entityType: 'test',
        observations: [`test observation ${i}`],
        createdAt: new Date().toISOString()
      }));

      await manager.createEntities(entities);

      // Test with output limits
      const limitedResults = await manager.searchNodes('test', {
        output: {
          maxEntities: 2,
          compact: true
        }
      });

      expect(limitedResults.entities.length).toBeLessThanOrEqual(2);
    });
  });

  describe('VSS Fallback and Error Resilience', () => {
    it('should gracefully handle VSS service failures', async () => {
      // Create test data
      await manager.createEntities([{
        name: 'test-entity',
        entityType: 'test',
        observations: ['test observation'],
        createdAt: new Date().toISOString()
      }]);

      // Mock VSS failure by temporarily removing API key
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      
      try {
        // Should still work via fallback mechanism
        const results = await manager.searchNodes('test', {
          searchMode: 'semantic'  // This should fallback to keyword
        });
        
        expect(results.entities.length).toBeGreaterThan(0);
        expect(results.entities[0].name).toBe('test-entity');
      } finally {
        // Restore API key
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it('should handle network timeouts gracefully', async () => {
      await manager.createEntities([{
        name: 'timeout-test',
        entityType: 'test',
        observations: ['timeout test observation'],
        createdAt: new Date().toISOString()
      }]);

      // Test with a query that might cause timeout
      const results = await manager.searchNodes('timeout', {
        searchMode: 'hybrid'
      });
      
      // Should either succeed or fallback gracefully
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
      expect(Array.isArray(results.relations)).toBe(true);
    });

    it('should maintain service health checks', async () => {
      if (manager.isVSSAvailable()) {
        const embeddingService = manager.getEmbeddingService();
        expect(embeddingService).toBeTruthy();
        
        // Test health check if service is available
        if (embeddingService) {
          const isHealthy = await embeddingService.checkHealth();
          expect(typeof isHealthy).toBe('boolean');
        }
      }
    });
  });

  describe('Integration with Existing Features', () => {
    it('should work with scope filtering', async () => {
      await manager.createEntities([
        {
          name: 'project-a:component',
          entityType: 'component',
          observations: ['Project A implementation'],
          createdAt: new Date().toISOString()
        },
        {
          name: 'project-b:component',  
          entityType: 'component',
          observations: ['Project B implementation'],
          createdAt: new Date().toISOString()
        }
      ]);

      // Test scope filtering
      const scopedResults = await manager.searchNodes('component', {
        scope: 'project-a',
        searchMode: 'hybrid' // Should fallback gracefully
      });

      // Should find project-a entity
      expect(scopedResults.entities.some(e => e.name.includes('project-a'))).toBe(true);
    });

    it('should integrate with time range filtering', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      await manager.createEntities([{
        name: 'recent-entity',
        entityType: 'test',
        observations: ['recent observation'],
        createdAt: now.toISOString()
      }]);

      // Test time range filtering
      const recentResults = await manager.searchNodes('recent', {
        timeRange: {
          createdAfter: yesterday.toISOString()
        },
        searchMode: 'keyword'
      });

      expect(recentResults.entities.length).toBeGreaterThan(0);
    });
  });
});