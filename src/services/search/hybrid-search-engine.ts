import type { Entity, SearchNodesOptions, KnowledgeGraph } from '../../types.js';
import type { VSSSearchOptions, VSSSearchResult } from '../../types/vss.js';
import type { IEmbeddingService } from '../../types/embedding.js';
import type { IVSSManager } from '../../types/vss.js';
import { logger } from '../../logger.js';
import { extractError } from '../../utils.js';

export interface KeywordSearchResult {
  entity: Entity;
  relevanceScore: number;
  matchSource: 'entity' | 'observation';
  matchedContent?: string;
}

export interface HybridSearchResult {
  entity: Entity;
  combinedScore: number;
  keywordScore?: number;
  semanticScore?: number;
  matchSource: 'entity' | 'observation';
  matchedContent?: string;
}

export interface SearchStrategy {
  performKeywordSearch(query: string, options?: SearchNodesOptions): Promise<KeywordSearchResult[]>;
}

export interface HybridSearchConfig {
  // RRF (Reciprocal Rank Fusion) parameters
  rrfK: number; // Constant for RRF calculation, typically 60
  
  // Weight factors for combining scores
  keywordWeight: number; // Weight for keyword search results
  semanticWeight: number; // Weight for semantic search results
  
  // Search thresholds
  semanticThreshold: number; // Minimum similarity for semantic results
  keywordMinScore: number; // Minimum relevance for keyword results
  
  // Result limits
  maxResultsPerStrategy: number; // Max results from each strategy before fusion
}

export const DEFAULT_HYBRID_CONFIG: HybridSearchConfig = {
  rrfK: 60,
  keywordWeight: 0.4,
  semanticWeight: 0.6,
  semanticThreshold: 0.7,
  keywordMinScore: 0.1,
  maxResultsPerStrategy: 50,
};

export class HybridSearchEngine {
  private embeddingService: IEmbeddingService;
  private vssManager: IVSSManager;
  private keywordSearchStrategy: SearchStrategy;
  private config: HybridSearchConfig;

  constructor(
    embeddingService: IEmbeddingService,
    vssManager: IVSSManager,
    keywordSearchStrategy: SearchStrategy,
    config: Partial<HybridSearchConfig> = {}
  ) {
    this.embeddingService = embeddingService;
    this.vssManager = vssManager;
    this.keywordSearchStrategy = keywordSearchStrategy;
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config };
  }

  /**
   * Perform hybrid search combining keyword and semantic search
   */
  async searchHybrid(
    query: string, 
    options: SearchNodesOptions = {}
  ): Promise<HybridSearchResult[]> {
    try {
      logger.info(`Starting hybrid search for: "${query}"`);
      
      // Determine search strategy based on options
      const searchMode = options.searchMode;
      
      switch (searchMode) {
        case 'keyword':
          return this.performKeywordOnlySearch(query, options);
        case 'semantic':
          return this.performSemanticOnlySearch(query, options);
        case 'hybrid':
        default:
          return this.performHybridSearch(query, options);
      }
    } catch (error) {
      logger.error('Hybrid search failed', extractError(error));
      // Fallback to keyword search if hybrid fails
      return this.performKeywordOnlySearch(query, options);
    }
  }

  /**
   * Perform keyword-only search
   */
  private async performKeywordOnlySearch(
    query: string, 
    options: SearchNodesOptions
  ): Promise<HybridSearchResult[]> {
    logger.info('Performing keyword-only search');
    
    const keywordResults = await this.keywordSearchStrategy.performKeywordSearch(
      query, 
      { ...options, searchMode: 'keyword' }
    );

    return keywordResults
      .filter(result => result.relevanceScore >= this.config.keywordMinScore)
      .map(result => ({
        entity: result.entity,
        combinedScore: result.relevanceScore,
        keywordScore: result.relevanceScore,
        matchSource: result.matchSource,
        matchedContent: result.matchedContent,
      }))
      .slice(0, options.output?.maxEntities || 20);
  }

  /**
   * Perform semantic-only search
   */
  private async performSemanticOnlySearch(
    query: string, 
    options: SearchNodesOptions
  ): Promise<HybridSearchResult[]> {
    logger.info('Performing semantic-only search');
    
    try {
      // Generate query embedding
      const embeddingResult = await this.embeddingService.generateEmbedding(query);
      
      // Perform VSS search
      const vssOptions: VSSSearchOptions = {
        threshold: this.config.semanticThreshold,
        limit: options.output?.maxEntities || 20,
        scope: options.scope,
        timeRange: options.timeRange,
        searchTarget: 'both',
        includeEmbeddings: false,
      };

      const semanticResults = await this.vssManager.searchWithVSS(
        embeddingResult.embedding, 
        vssOptions
      );

      return semanticResults.map(result => ({
        entity: result.entity,
        combinedScore: result.similarity,
        semanticScore: result.similarity,
        matchSource: result.matchSource,
        matchedContent: result.matchedContent,
      }));
    } catch (error) {
      logger.warn('Semantic search failed, falling back to keyword search', extractError(error));
      return this.performKeywordOnlySearch(query, options);
    }
  }

  /**
   * Perform full hybrid search with RRF fusion
   */
  private async performHybridSearch(
    query: string, 
    options: SearchNodesOptions
  ): Promise<HybridSearchResult[]> {
    logger.info('Performing hybrid search with RRF fusion');
    
    // Execute both searches concurrently
    const [keywordResults, semanticResults] = await Promise.allSettled([
      this.executeKeywordSearch(query, options),
      this.executeSemanticSearch(query, options)
    ]);

    // Extract successful results
    const keywordData = keywordResults.status === 'fulfilled' ? keywordResults.value : [];
    const semanticData = semanticResults.status === 'fulfilled' ? semanticResults.value : [];

    if (keywordResults.status === 'rejected') {
      logger.warn('Keyword search failed in hybrid mode', extractError(keywordResults.reason));
    }
    
    if (semanticResults.status === 'rejected') {
      logger.warn('Semantic search failed in hybrid mode', extractError(semanticResults.reason));
    }

    // If both searches failed, return empty results
    if (keywordData.length === 0 && semanticData.length === 0) {
      logger.error('Both keyword and semantic searches failed');
      return [];
    }

    // Perform RRF fusion
    const fusedResults = this.fuseResults(keywordData, semanticData);
    
    // Apply final limits
    const maxResults = options.output?.maxEntities || 20;
    return fusedResults.slice(0, maxResults);
  }

  /**
   * Execute keyword search
   */
  private async executeKeywordSearch(
    query: string, 
    options: SearchNodesOptions
  ): Promise<KeywordSearchResult[]> {
    const results = await this.keywordSearchStrategy.performKeywordSearch(query, {
      ...options,
      output: {
        ...options.output,
        maxEntities: this.config.maxResultsPerStrategy,
      }
    });

    return results.filter(result => result.relevanceScore >= this.config.keywordMinScore);
  }

  /**
   * Execute semantic search
   */
  private async executeSemanticSearch(
    query: string, 
    options: SearchNodesOptions
  ): Promise<VSSSearchResult[]> {
    // Generate query embedding
    const embeddingResult = await this.embeddingService.generateEmbedding(query);
    
    // Perform VSS search
    const vssOptions: VSSSearchOptions = {
      threshold: this.config.semanticThreshold,
      limit: this.config.maxResultsPerStrategy,
      scope: options.scope,
      timeRange: options.timeRange,
      searchTarget: 'both',
      includeEmbeddings: false,
    };

    return this.vssManager.searchWithVSS(embeddingResult.vector, vssOptions);
  }

  /**
   * Fuse keyword and semantic results using RRF (Reciprocal Rank Fusion)
   */
  private fuseResults(
    keywordResults: KeywordSearchResult[],
    semanticResults: VSSSearchResult[]
  ): HybridSearchResult[] {
    logger.info(`Fusing ${keywordResults.length} keyword results with ${semanticResults.length} semantic results`);
    
    const entityMap = new Map<string, HybridSearchResult>();

    // Process keyword results
    keywordResults.forEach((result, index) => {
      const entityName = result.entity.name;
      const rrfScore = 1 / (this.config.rrfK + index + 1);
      const weightedScore = rrfScore * this.config.keywordWeight;

      entityMap.set(entityName, {
        entity: result.entity,
        combinedScore: weightedScore,
        keywordScore: result.relevanceScore,
        matchSource: result.matchSource,
        matchedContent: result.matchedContent,
      });
    });

    // Process semantic results
    semanticResults.forEach((result, index) => {
      const entityName = result.entity.name;
      const rrfScore = 1 / (this.config.rrfK + index + 1);
      const weightedScore = rrfScore * this.config.semanticWeight;

      const existing = entityMap.get(entityName);
      if (existing) {
        // Combine scores for entities found in both searches
        existing.combinedScore += weightedScore;
        existing.semanticScore = result.similarity;
        // Prefer semantic match source and content if available
        if (result.matchedContent) {
          existing.matchSource = result.matchSource;
          existing.matchedContent = result.matchedContent;
        }
      } else {
        // Add new entity from semantic search
        entityMap.set(entityName, {
          entity: result.entity,
          combinedScore: weightedScore,
          semanticScore: result.similarity,
          matchSource: result.matchSource,
          matchedContent: result.matchedContent,
        });
      }
    });

    // Sort by combined score and return
    const fusedResults = Array.from(entityMap.values())
      .sort((a, b) => b.combinedScore - a.combinedScore);

    logger.info(`RRF fusion produced ${fusedResults.length} unique results`);
    return fusedResults;
  }

  /**
   * Update hybrid search configuration
   */
  updateConfig(newConfig: Partial<HybridSearchConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('Hybrid search configuration updated', newConfig);
  }

  /**
   * Get current configuration
   */
  getConfig(): HybridSearchConfig {
    return { ...this.config };
  }

  /**
   * Check if semantic search is available
   */
  async isSemanticSearchAvailable(): Promise<boolean> {
    try {
      return this.vssManager.isEnabled() && await this.embeddingService.checkHealth();
    } catch {
      return false;
    }
  }
}