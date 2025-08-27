import type { Database, Connection } from 'duckdb';
import type {
  IVSSManager,
  VSSConfig,
  VSSSearchOptions,
  VSSSearchResult,
  VSSHealthCheck,
  VSSStats,
  VSSIndexStatus,
} from '../../types/vss.js';
import { VSSError } from '../../types/vss.js';
import type { EmbeddingVector, IEmbeddingService } from '../../types/embedding.js';
import type { Entity } from '../../types.js';
import { logger } from '../../logger.js';

export class DuckDBVSSManager implements IVSSManager {
  private connection: Connection;
  private embeddingService: IEmbeddingService;
  private config: VSSConfig;
  private extensionLoaded: boolean = false;
  private indexesCreated: boolean = false;
  private lastHealthCheck: VSSHealthCheck | null = null;
  private searchStats = {
    totalSearches: 0,
    semanticSearches: 0,
    hybridSearches: 0,
    totalLatency: 0,
  };

  constructor(
    connection: Connection,
    embeddingService: IEmbeddingService,
    config: VSSConfig
  ) {
    this.connection = connection;
    this.embeddingService = embeddingService;
    this.config = config;

    logger.info('VSS Manager initialized', { 
      enabled: config.enabled,
      metric: config.indexParams.metric,
      fallbackEnabled: config.fallback.enabled
    });
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('VSS is disabled, skipping initialization');
      return;
    }

    try {
      await this.loadVSSExtension();
      await this.createOrUpdateIndexes();
      
      logger.info('VSS Manager initialization completed successfully');
    } catch (error) {
      logger.error('Failed to initialize VSS Manager', { error });
      
      if (!this.config.fallback.enabled) {
        throw new (VSSError as any)(
          `VSS initialization failed: ${error}`,
          'VSS_INIT_FAILED',
          false,
          false
        );
      }
      
      logger.warn('VSS initialization failed, fallback mode enabled');
    }
  }

  isEnabled(): boolean {
    return this.config.enabled && this.extensionLoaded && this.indexesCreated;
  }

  async createOrUpdateIndexes(): Promise<void> {
    if (!this.extensionLoaded) {
      await this.loadVSSExtension();
    }

    try {
      // 檢查現有索引
      const existingIndexes = await this.getExistingIndexes();
      
      // 為 entities 表建立 HNSW 索引
      if (!existingIndexes.some(idx => idx.name === 'entities_embedding_idx')) {
        await this.createEntityEmbeddingIndex();
      }

      // 為 observations 表建立 HNSW 索引  
      if (!existingIndexes.some(idx => idx.name === 'observations_embedding_idx')) {
        await this.createObservationEmbeddingIndex();
      }

      this.indexesCreated = true;
      logger.info('VSS indexes created/updated successfully');
    } catch (error) {
      logger.error('Failed to create/update VSS indexes', { error });
      throw new VSSError(
        `Failed to create VSS indexes: ${error}`,
        'INDEX_CREATION_FAILED',
        false,
        true
      );
    }
  }

  async searchWithVSS(
    queryEmbedding: EmbeddingVector,
    options: VSSSearchOptions = {}
  ): Promise<VSSSearchResult[]> {
    const startTime = Date.now();
    
    if (!this.isEnabled()) {
      throw new (VSSError as any)(
        'VSS is not available',
        'VSS_NOT_AVAILABLE',
        false,
        true
      );
    }

    const {
      threshold = 0.7,
      limit = 20,
      scope,
      timeRange,
      includeEmbeddings = false,
      searchTarget = 'both',
    } = options;

    try {
      let results: VSSSearchResult[] = [];

      // 搜尋實體
      if (searchTarget === 'entities' || searchTarget === 'both') {
        const entityResults = await this.searchEntitiesWithVSS(
          queryEmbedding,
          { threshold, limit: Math.ceil(limit / 2), scope, timeRange, includeEmbeddings }
        );
        results.push(...entityResults);
      }

      // 搜尋觀察
      if (searchTarget === 'observations' || searchTarget === 'both') {
        const observationResults = await this.searchObservationsWithVSS(
          queryEmbedding,
          { threshold, limit: Math.ceil(limit / 2), scope, timeRange, includeEmbeddings }
        );
        results.push(...observationResults);
      }

      // 按相似度排序並限制結果數量
      results = results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      // 更新統計
      const latency = Date.now() - startTime;
      this.updateSearchStats('semantic', latency);

      logger.debug('VSS search completed', {
        queryDimension: queryEmbedding.length,
        threshold,
        limit,
        searchTarget,
        resultsCount: results.length,
        latency,
      });

      return results;
    } catch (error) {
      logger.error('VSS search failed', { error, options });
      throw new (VSSError as any)(
        `VSS search failed: ${error}`,
        'VSS_SEARCH_FAILED',
        true,
        true
      );
    }
  }

  async updateEntityEmbeddings(entityNames: string[]): Promise<void> {
    if (entityNames.length === 0) return;

    logger.debug('Updating entity embeddings', { count: entityNames.length });

    try {
      // 批量處理以避免過大的查詢
      const batchSize = this.config.autoRebuild.batchSize;
      
      for (let i = 0; i < entityNames.length; i += batchSize) {
        const batch = entityNames.slice(i, i + batchSize);
        await this.processBatchEntityEmbeddings(batch);
      }

      logger.info('Entity embeddings updated successfully', { 
        count: entityNames.length 
      });
    } catch (error) {
      logger.error('Failed to update entity embeddings', { error, entityNames });
      throw error;
    }
  }

  async batchUpdateEmbeddings(entities: Entity[]): Promise<void> {
    if (entities.length === 0) return;

    logger.debug('Batch updating embeddings for entities', { count: entities.length });

    try {
      // 準備文本資料
      const textsToEmbed: string[] = [];
      const entityTexts = new Map<string, string>();

      entities.forEach(entity => {
        const text = this.prepareEntityTextForEmbedding(entity);
        textsToEmbed.push(text);
        entityTexts.set(entity.name, text);
      });

      // 批量生成 embeddings
      const batchResult = await this.embeddingService.generateBatchEmbeddings(textsToEmbed);
      
      // 更新資料庫
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const embedding = batchResult.embeddings[i];
        
        await this.updateEntityEmbeddingInDB(entity.name, embedding.vector);
      }

      logger.info('Batch embedding update completed', {
        entitiesCount: entities.length,
        tokensUsed: batchResult.totalUsage.totalTokens,
      });
    } catch (error) {
      logger.error('Batch embedding update failed', { error });
      throw error;
    }
  }

  async checkHealth(): Promise<VSSHealthCheck> {
    const healthCheck: VSSHealthCheck = {
      vssExtensionLoaded: false,
      indexesHealthy: false,
      indexes: [],
      embeddingService: false,
      cache: false,
      overallStatus: 'unhealthy',
      issues: [],
    };

    try {
      // 檢查 VSS Extension
      healthCheck.vssExtensionLoaded = await this.checkVSSExtension();
      if (!healthCheck.vssExtensionLoaded) {
        healthCheck.issues.push('VSS extension not loaded');
      }

      // 檢查索引狀態
      if (healthCheck.vssExtensionLoaded) {
        healthCheck.indexes = await this.getIndexStatuses();
        healthCheck.indexesHealthy = healthCheck.indexes.every(idx => idx.isHealthy);
        
        if (!healthCheck.indexesHealthy) {
          healthCheck.issues.push('One or more VSS indexes are unhealthy');
        }
      }

      // 檢查 embedding 服務
      healthCheck.embeddingService = await this.embeddingService.checkHealth();
      if (!healthCheck.embeddingService) {
        healthCheck.issues.push('Embedding service is not available');
      }

      // 檢查快取（假設有快取服務）
      healthCheck.cache = true; // 簡化實現，實際應檢查快取服務

      // 計算整體狀態
      if (healthCheck.issues.length === 0) {
        healthCheck.overallStatus = 'healthy';
      } else if (healthCheck.vssExtensionLoaded || healthCheck.embeddingService) {
        healthCheck.overallStatus = 'degraded';
      } else {
        healthCheck.overallStatus = 'unhealthy';
      }

      this.lastHealthCheck = healthCheck;
      return healthCheck;
    } catch (error) {
      logger.error('VSS health check failed', { error });
      healthCheck.issues.push(`Health check failed: ${error}`);
      return healthCheck;
    }
  }

  async getStats(): Promise<VSSStats> {
    try {
      const [entitiesWithEmbeddings, observationsWithEmbeddings, totalEntities, totalObservations] = 
        await Promise.all([
          this.countEntitiesWithEmbeddings(),
          this.countObservationsWithEmbeddings(),
          this.countTotalEntities(),
          this.countTotalObservations(),
        ]);

      const indexStats = await this.getIndexStatuses();

      return {
        totalEntitiesWithEmbeddings: entitiesWithEmbeddings,
        totalObservationsWithEmbeddings: observationsWithEmbeddings,
        embeddingCoverage: {
          entities: totalEntities > 0 ? (entitiesWithEmbeddings / totalEntities) * 100 : 0,
          observations: totalObservations > 0 ? (observationsWithEmbeddings / totalObservations) * 100 : 0,
        },
        indexStats,
        cacheStats: {
          hitRate: 0, // TODO: 從快取服務獲取
          size: 0,
          maxSize: 1000,
        },
        searchStats: {
          totalSearches: this.searchStats.totalSearches,
          semanticSearches: this.searchStats.semanticSearches,
          hybridSearches: this.searchStats.hybridSearches,
          avgLatency: this.searchStats.totalSearches > 0 
            ? this.searchStats.totalLatency / this.searchStats.totalSearches 
            : 0,
        },
      };
    } catch (error) {
      logger.error('Failed to get VSS stats', { error });
      throw error;
    }
  }

  async rebuildIndexes(): Promise<void> {
    logger.info('Starting VSS indexes rebuild');

    try {
      // 刪除現有索引
      await this.dropExistingIndexes();
      
      // 重新創建索引
      await this.createOrUpdateIndexes();
      
      logger.info('VSS indexes rebuilt successfully');
    } catch (error) {
      logger.error('Failed to rebuild VSS indexes', { error });
      throw error;
    }
  }

  async cleanupInvalidEmbeddings(): Promise<void> {
    logger.info('Starting cleanup of invalid embeddings');

    try {
      // 清理無效的實體 embeddings
      await this.cleanupInvalidEntityEmbeddings();
      
      // 清理無效的觀察 embeddings
      await this.cleanupInvalidObservationEmbeddings();
      
      logger.info('Invalid embeddings cleanup completed');
    } catch (error) {
      logger.error('Failed to cleanup invalid embeddings', { error });
      throw error;
    }
  }

  // 私有方法實現

  private async loadVSSExtension(): Promise<void> {
    try {
      await this.executeQuery("INSTALL vss;");
      await this.executeQuery("LOAD vss;");
      this.extensionLoaded = true;
      logger.debug('VSS extension loaded successfully');
    } catch (error) {
      logger.error('Failed to load VSS extension', { error });
      throw error;
    }
  }

  private async createEntityEmbeddingIndex(): Promise<void> {
    const sql = `
      CREATE INDEX entities_embedding_idx ON entities 
      USING HNSW (embedding) 
      WITH (metric = '${this.config.indexParams.metric}', 
            ef_construction = ${this.config.indexParams.efConstruction}, 
            M = ${this.config.indexParams.M});
    `;
    
    await this.executeQuery(sql);
    logger.debug('Entity embedding HNSW index created');
  }

  private async createObservationEmbeddingIndex(): Promise<void> {
    const sql = `
      CREATE INDEX observations_embedding_idx ON observations 
      USING HNSW (embedding) 
      WITH (metric = '${this.config.indexParams.metric}', 
            ef_construction = ${this.config.indexParams.efConstruction}, 
            M = ${this.config.indexParams.M});
    `;
    
    await this.executeQuery(sql);
    logger.debug('Observation embedding HNSW index created');
  }

  private async searchEntitiesWithVSS(
    queryEmbedding: EmbeddingVector,
    options: VSSSearchOptions
  ): Promise<VSSSearchResult[]> {
    let sql = `
      SELECT e.name, e.entityType, e.observations, e.createdAt, e.embedding,
             array_cosine_similarity(e.embedding, $1::FLOAT[]) as similarity
      FROM entities e
      WHERE e.embedding IS NOT NULL
        AND array_cosine_similarity(e.embedding, $1::FLOAT[]) >= $2
    `;

    const params: any[] = [queryEmbedding, options.threshold || 0.7];
    let paramIndex = 2;

    // 添加 scope 過濾
    if (options.scope) {
      paramIndex++;
      sql += ` AND e.name LIKE $${paramIndex}`;
      params.push(`${options.scope}%`);
    }

    // 添加時間範圍過濾
    if (options.timeRange) {
      const timeCondition = this.buildTimeCondition(options.timeRange);
      if (timeCondition.condition) {
        sql += ` AND ${timeCondition.condition}`;
        params.push(...timeCondition.params);
      }
    }

    sql += ` ORDER BY similarity DESC LIMIT $${paramIndex + 1}`;
    params.push(options.limit || 20);

    try {
      const rows = await this.executeQuery(sql, params);
      
      return rows.map((row: any) => ({
        entity: {
          name: row.name,
          entityType: row.entityType,
          observations: JSON.parse(row.observations || '[]'),
          createdAt: row.createdAt,
        },
        similarity: row.similarity,
        matchSource: 'entity' as const,
        embedding: options.includeEmbeddings ? row.embedding : undefined,
      }));
    } catch (error) {
      logger.error('Entity VSS search failed', { error });
      throw error;
    }
  }

  private async searchObservationsWithVSS(
    queryEmbedding: EmbeddingVector,
    options: VSSSearchOptions
  ): Promise<VSSSearchResult[]> {
    let sql = `
      SELECT o.entityName, o.content, o.createdAt, o.embedding,
             e.entityType, e.observations,
             array_cosine_similarity(o.embedding, $1::FLOAT[]) as similarity
      FROM observations o
      JOIN entities e ON o.entityName = e.name
      WHERE o.embedding IS NOT NULL
        AND array_cosine_similarity(o.embedding, $1::FLOAT[]) >= $2
    `;

    const params: any[] = [queryEmbedding, options.threshold || 0.7];
    let paramIndex = 2;

    // 添加相同的過濾邏輯
    if (options.scope) {
      paramIndex++;
      sql += ` AND o.entityName LIKE $${paramIndex}`;
      params.push(`${options.scope}%`);
    }

    sql += ` ORDER BY similarity DESC LIMIT $${paramIndex + 1}`;
    params.push(options.limit || 20);

    try {
      const rows = await this.executeQuery(sql, params);
      
      return rows.map((row: any) => ({
        entity: {
          name: row.entityName,
          entityType: row.entityType,
          observations: JSON.parse(row.observations || '[]'),
          createdAt: row.createdAt,
        },
        similarity: row.similarity,
        matchSource: 'observation' as const,
        matchedContent: row.content,
        embedding: options.includeEmbeddings ? row.embedding : undefined,
      }));
    } catch (error) {
      logger.error('Observation VSS search failed', { error });
      throw error;
    }
  }

  private async processBatchEntityEmbeddings(entityNames: string[]): Promise<void> {
    // 獲取實體資料
    const entities = await this.getEntitiesByNames(entityNames);
    
    // 準備文本並生成 embeddings
    const textsToEmbed = entities.map(e => this.prepareEntityTextForEmbedding(e));
    const batchResult = await this.embeddingService.generateBatchEmbeddings(textsToEmbed);

    // 更新資料庫
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const embedding = batchResult.embeddings[i];
      await this.updateEntityEmbeddingInDB(entity.name, embedding.vector);
    }
  }

  private prepareEntityTextForEmbedding(entity: Entity): string {
    // 組合實體的文本內容用於 embedding
    const parts = [
      entity.name,
      entity.entityType,
      ...(entity.observations || [])
    ];
    return parts.join(' ');
  }

  private async updateEntityEmbeddingInDB(entityName: string, embedding: EmbeddingVector): Promise<void> {
    const sql = `
      UPDATE entities 
      SET embedding = $1::FLOAT[], 
          embedding_updated_at = CURRENT_TIMESTAMP,
          embedding_model = $3
      WHERE name = $2
    `;
    
    await this.executeQuery(sql, [
      embedding, 
      entityName, 
      this.embeddingService.getConfig().model
    ]);
  }

  private async getEntitiesByNames(names: string[]): Promise<Entity[]> {
    if (names.length === 0) return [];
    
    const placeholders = names.map((_, i) => `$${i + 1}`).join(',');
    const sql = `
      SELECT name, entityType, observations, createdAt 
      FROM entities 
      WHERE name IN (${placeholders})
    `;
    
    const rows = await this.executeQuery(sql, names);
    return rows.map((row: any) => ({
      name: row.name,
      entityType: row.entityType,
      observations: JSON.parse(row.observations || '[]'),
      createdAt: row.createdAt,
    }));
  }

  private buildTimeCondition(timeRange: any): { condition: string; params: any[] } {
    // 這裡重用現有的時間條件構建邏輯
    // TODO: 實際實現需要從 DuckDBManager 中提取
    return { condition: '', params: [] };
  }

  private async checkVSSExtension(): Promise<boolean> {
    try {
      await this.executeQuery("SELECT 1 FROM duckdb_extensions() WHERE extension_name = 'vss' AND loaded = true");
      return true;
    } catch {
      return false;
    }
  }

  private async getExistingIndexes(): Promise<Array<{ name: string }>> {
    try {
      const result = await this.executeQuery(`
        SELECT index_name as name 
        FROM duckdb_indexes() 
        WHERE index_name LIKE '%embedding%'
      `);
      
      // 轉換 DuckDB 結果為陣列格式
      const indexes: Array<{ name: string }> = [];
      if (result && result.numRows > 0) {
        const nameColumn = result.getChild('name');
        for (let i = 0; i < result.numRows; i++) {
          const name = nameColumn?.get(i);
          if (name) {
            indexes.push({ name });
          }
        }
      }
      
      return indexes;
    } catch (error) {
      logger.debug('Failed to get existing indexes, assuming none exist', { error });
      return [];
    }
  }

  private async getIndexStatuses(): Promise<VSSIndexStatus[]> {
    // 簡化實現，實際應檢查每個索引的詳細狀態
    return [
      {
        name: 'entities_embedding_idx',
        table: 'entities',
        column: 'embedding',
        indexType: 'HNSW',
        metric: this.config.indexParams.metric,
        dimensions: 1536, // TODO: 從配置獲取
        totalVectors: await this.countEntitiesWithEmbeddings(),
        parameters: this.config.indexParams,
        isHealthy: true,
        lastUpdated: new Date().toISOString(),
      },
    ];
  }

  private async countEntitiesWithEmbeddings(): Promise<number> {
    const result = await this.executeQuery('SELECT COUNT(*) as count FROM entities WHERE embedding IS NOT NULL');
    return result[0]?.count || 0;
  }

  private async countObservationsWithEmbeddings(): Promise<number> {
    const result = await this.executeQuery('SELECT COUNT(*) as count FROM observations WHERE embedding IS NOT NULL');
    return result[0]?.count || 0;
  }

  private async countTotalEntities(): Promise<number> {
    const result = await this.executeQuery('SELECT COUNT(*) as count FROM entities');
    return result[0]?.count || 0;
  }

  private async countTotalObservations(): Promise<number> {
    const result = await this.executeQuery('SELECT COUNT(*) as count FROM observations');
    return result[0]?.count || 0;
  }

  private async dropExistingIndexes(): Promise<void> {
    const indexes = ['entities_embedding_idx', 'observations_embedding_idx'];
    
    for (const indexName of indexes) {
      try {
        await this.executeQuery(`DROP INDEX IF EXISTS ${indexName}`);
      } catch (error) {
        logger.warn(`Failed to drop index ${indexName}`, { error });
      }
    }
  }

  private async cleanupInvalidEntityEmbeddings(): Promise<void> {
    await this.executeQuery(`
      UPDATE entities 
      SET embedding = NULL, embedding_updated_at = NULL 
      WHERE embedding IS NOT NULL 
        AND (array_length(embedding, 1) = 0 OR embedding IS NULL)
    `);
  }

  private async cleanupInvalidObservationEmbeddings(): Promise<void> {
    await this.executeQuery(`
      UPDATE observations 
      SET embedding = NULL, embedding_updated_at = NULL 
      WHERE embedding IS NOT NULL 
        AND (array_length(embedding, 1) = 0 OR embedding IS NULL)
    `);
  }

  private updateSearchStats(type: 'semantic' | 'hybrid', latency: number): void {
    this.searchStats.totalSearches++;
    this.searchStats.totalLatency += latency;
    
    if (type === 'semantic') {
      this.searchStats.semanticSearches++;
    } else if (type === 'hybrid') {
      this.searchStats.hybridSearches++;
    }
  }

  private async executeQuery(sql: string, params?: any[]): Promise<any> {
    try {
      const result = await this.connection.runAndReadAll(sql, params);
      return result;
    } catch (error) {
      logger.error('VSS query execution failed', { sql, params, error });
      throw error;
    }
  }
}