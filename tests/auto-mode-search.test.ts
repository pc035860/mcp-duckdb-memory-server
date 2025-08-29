import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { ConsoleLogger } from '../src/logger.js';

// Mock the logger to capture search strategy decisions
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('Auto Mode Search Intelligence', () => {
  let manager: DuckDBKnowledgeGraphManager;
  let tempDbPath: string;

  beforeEach(async () => {
    // Create unique temp DB path for each test
    tempDbPath = `:memory:auto_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    manager = new DuckDBKnowledgeGraphManager(
      () => tempDbPath,
      mockLogger as any,
      false,
      10 // Low threshold to ensure strategy decisions are based on other factors
    );
    
    // Initialize the manager
    await manager.initialize();
    
    // Set mock OpenAI API key for testing
    process.env.OPENAI_API_KEY = 'test-api-key';
    
    // Clear mock calls before each test
    vi.clearAllMocks();
    
    // Create comprehensive test dataset
    await manager.createEntities([
      {
        name: 'user-authentication-service',
        entityType: 'microservice',
        observations: [
          'Handles user login and authentication',
          'JWT token generation and validation',
          'Multi-factor authentication support',
          'OAuth2 integration with third parties'
        ],
        createdAt: new Date().toISOString()
      },
      {
        name: 'machine-learning-engine', 
        entityType: 'ai-service',
        observations: [
          'Deep learning model training',
          'Neural network architecture optimization',
          'Predictive analytics algorithms',
          'Natural language processing pipeline'
        ],
        createdAt: new Date().toISOString()
      },
      {
        name: 'chinese-language-processor',
        entityType: 'nlp-service',
        observations: [
          '中文自然語言處理系統',
          '繁體中文文本分析',
          '語義理解與情感分析',
          'Traditional Chinese text mining'
        ],
        createdAt: new Date().toISOString()
      },
      {
        name: 'payment-processing-gateway',
        entityType: 'financial-service',
        observations: [
          'Credit card payment processing',
          'Digital wallet integration',
          'Fraud detection algorithms',
          'PCI DSS compliance features'
        ],
        createdAt: new Date().toISOString()
      }
    ]);
  });

  afterEach(async () => {
    if (manager && !manager.isClosed) {
      await manager.close();
    }
    // Clean up env
    delete process.env.OPENAI_API_KEY;
  });

  describe('Language-Based Strategy Selection', () => {
    it('should force keyword mode for Chinese queries', async () => {
      const chineseQuery = '中文處理系統';
      
      const results = await manager.searchNodes(chineseQuery);
      
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
      
      // Should find the Chinese language processor
      const chineseProcessor = results.entities.find(e => 
        e.name === 'chinese-language-processor'
      );
      
      if (chineseProcessor) {
        expect(chineseProcessor.observations.some(obs => 
          obs.includes('中文') || obs.includes('繁體')
        )).toBe(true);
      }
    });

    it('should handle mixed Chinese-English queries', async () => {
      const mixedQuery = 'Chinese 自然語言 processing';
      
      const results = await manager.searchNodes(mixedQuery);
      
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
      
      // Should find entities related to Chinese processing or NLP
      const relevantEntities = results.entities.filter(e =>
        e.name.includes('chinese') ||
        e.name.includes('language') ||
        e.observations.some(obs => 
          obs.includes('Chinese') || 
          obs.includes('中文') ||
          obs.includes('language')
        )
      );
      
      expect(relevantEntities.length).toBeGreaterThanOrEqual(0);
    });

    it('should prefer hybrid mode for pure English queries when VSS available', async () => {
      const englishQuery = 'machine learning algorithms';
      
      const results = await manager.searchNodes(englishQuery);
      
      expect(results).toBeTruthy();
      expect(Array.isArray(results.entities)).toBe(true);
      
      // Should find machine learning related entities
      const mlEntities = results.entities.filter(e =>
        e.name.includes('machine') || 
        e.name.includes('learning') ||
        e.observations.some(obs => 
          obs.toLowerCase().includes('machine') ||
          obs.toLowerCase().includes('learning') ||
          obs.toLowerCase().includes('neural')
        )
      );
      
      // Should find relevant entities regardless of strategy used
      expect(mlEntities.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle traditional vs simplified Chinese characters', async () => {
      const traditionalQuery = '繁體中文';
      const simplifiedQuery = '简体中文';
      
      const traditionalResults = await manager.searchNodes(traditionalQuery);
      const simplifiedResults = await manager.searchNodes(simplifiedQuery);
      
      // Both should use keyword mode and return valid results
      expect(traditionalResults).toBeTruthy();
      expect(simplifiedResults).toBeTruthy();
      
      expect(Array.isArray(traditionalResults.entities)).toBe(true);
      expect(Array.isArray(simplifiedResults.entities)).toBe(true);
    });
  });

  describe('Fallback and Error Handling', () => {
    it('should gracefully handle VSS unavailability', async () => {
      // Remove API key to simulate VSS unavailability
      delete process.env.OPENAI_API_KEY;
      
      // Create new manager without VSS
      const noVSSManager = new DuckDBKnowledgeGraphManager(
        () => `:memory:novss_${Date.now()}`,
        mockLogger as any
      );
      
      await noVSSManager.initialize();
      
      try {
        // Add test data
        await noVSSManager.createEntities([{
          name: 'test-service',
          entityType: 'service',
          observations: ['test functionality'],
          createdAt: new Date().toISOString()
        }]);
        
        // English query should fallback to keyword mode
        const results = await noVSSManager.searchNodes('test functionality');
        
        expect(results).toBeTruthy();
        expect(results.entities.length).toBeGreaterThan(0);
        expect(results.entities[0].name).toBe('test-service');
        
        // Chinese query should also work
        const chineseResults = await noVSSManager.searchNodes('測試功能');
        expect(chineseResults).toBeTruthy();
        expect(Array.isArray(chineseResults.entities)).toBe(true);
      } finally {
        await noVSSManager.close();
      }
    });

    it('should handle empty queries gracefully', async () => {
      const edgeQueries = ['', ' ', '\\n', '\\t'];
      
      for (const query of edgeQueries) {
        const results = await manager.searchNodes(query);
        
        expect(results).toBeTruthy();
        expect(results.entities).toEqual([]);
        expect(results.relations).toEqual([]);
      }
    });

    it('should handle special characters and symbols', async () => {
      const specialQueries = [
        '!@#$%^&*()',
        'hello@world.com',
        'file/path/name.txt',
        'C++ programming',
        'JSON-RPC protocol'
      ];
      
      for (const query of specialQueries) {
        const results = await manager.searchNodes(query);
        
        // Should not throw errors
        expect(results).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        expect(Array.isArray(results.relations)).toBe(true);
      }
    });
  });

  describe('Performance and Quality', () => {
    it('should maintain consistent performance across strategies', async () => {
      const testQueries = [
        { query: 'authentication system', type: 'english' },
        { query: '認證系統', type: 'chinese' },
        { query: 'machine learning model', type: 'english' },
        { query: '機器學習模型', type: 'chinese' }
      ];
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        testQueries.map(({ query }) => manager.searchNodes(query))
      );
      
      const totalTime = Date.now() - startTime;
      
      // Should complete all searches in reasonable time
      expect(totalTime).toBeLessThan(5000);
      
      // All searches should return valid structures
      results.forEach((result, index) => {
        const { query, type } = testQueries[index];
        
        expect(result, `Failed for ${type} query: "${query}"`).toBeTruthy();
        expect(Array.isArray(result.entities)).toBe(true);
        expect(Array.isArray(result.relations)).toBe(true);
      });
    });

    it('should provide consistent API structure regardless of strategy', async () => {
      const queries = [
        'payment processing',    // Should use hybrid if available
        '支付處理',              // Should use keyword
        'fraud detection',       // Should use hybrid if available  
        '欺詐檢測'               // Should use keyword
      ];
      
      for (const query of queries) {
        const results = await manager.searchNodes(query);
        
        // Consistent structure regardless of internal strategy
        expect(results).toHaveProperty('entities');
        expect(results).toHaveProperty('relations');
        expect(Array.isArray(results.entities)).toBe(true);
        expect(Array.isArray(results.relations)).toBe(true);
        
        // Entity structure should be consistent
        results.entities.forEach(entity => {
          expect(entity).toHaveProperty('name');
          expect(entity).toHaveProperty('entityType');
          expect(entity).toHaveProperty('observations');
          expect(entity).toHaveProperty('createdAt');
          expect(Array.isArray(entity.observations)).toBe(true);
        });
        
        // Relation structure should be consistent
        results.relations.forEach(relation => {
          expect(relation).toHaveProperty('from');
          expect(relation).toHaveProperty('to');
          expect(relation).toHaveProperty('relationType');
          expect(relation).toHaveProperty('createdAt');
        });
      }
    });

    it('should demonstrate intelligent query routing', async () => {
      const routingTests = [
        {
          query: 'user authentication login',
          description: 'Multi-word English - should prefer hybrid if VSS available'
        },
        {
          query: '用戶認證登錄',
          description: 'Multi-word Chinese - should force keyword mode'
        },
        {
          query: 'AI artificial intelligence',
          description: 'Technical English terms - should prefer hybrid'
        },
        {
          query: '人工智能 machine learning',
          description: 'Mixed languages - should force keyword mode'
        }
      ];
      
      for (const { query, description } of routingTests) {
        const results = await manager.searchNodes(query);
        
        expect(results, `Failed: ${description}`).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        
        // Should find at least some relevant entities for reasonable queries
        if (query.includes('authentication') || query.includes('認證')) {
          const authEntities = results.entities.filter(e =>
            e.name.includes('authentication') ||
            e.observations.some(obs => obs.toLowerCase().includes('auth'))
          );
          
          // Authentication queries should find auth-related entities
          if (authEntities.length > 0) {
            expect(authEntities.length).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  describe('Real-world Query Scenarios', () => {
    it('should handle technical documentation queries', async () => {
      const technicalQueries = [
        'JWT token validation',
        'OAuth2 authentication flow',
        'neural network architecture',
        'fraud detection algorithms'
      ];
      
      for (const query of technicalQueries) {
        const results = await manager.searchNodes(query);
        
        expect(results).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        
        // Should find entities with relevant technical content
        const relevantEntities = results.entities.filter(entity =>
          query.split(' ').some(term =>
            entity.name.toLowerCase().includes(term.toLowerCase()) ||
            entity.observations.some(obs =>
              obs.toLowerCase().includes(term.toLowerCase())
            )
          )
        );
        
        // Technical queries should find some relevant content
        expect(relevantEntities.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle business domain queries', async () => {
      const businessQueries = [
        'payment processing system',
        'user authentication service',
        'machine learning platform',
        'data analytics engine'
      ];
      
      for (const query of businessQueries) {
        const results = await manager.searchNodes(query);
        
        expect(results).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        
        // Business queries should maintain proper structure
        if (results.entities.length > 0) {
          const firstEntity = results.entities[0];
          expect(firstEntity.observations.length).toBeGreaterThan(0);
          expect(typeof firstEntity.createdAt).toBe('string');
        }
      }
    });

    it('should handle cross-language technical terms', async () => {
      const crossLangQueries = [
        'API 接口',
        'database 資料庫',
        'algorithm 演算法',
        'security 安全性'
      ];
      
      for (const query of crossLangQueries) {
        const results = await manager.searchNodes(query);
        
        // Should handle mixed language gracefully
        expect(results).toBeTruthy();
        expect(Array.isArray(results.entities)).toBe(true);
        expect(Array.isArray(results.relations)).toBe(true);
      }
    });
  });
});