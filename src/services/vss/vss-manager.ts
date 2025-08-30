import type { DuckDBConnection } from '@duckdb/node-api';
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
import { getModelDimensions } from '../embedding/index.js';
import { logger } from '../../logger.js';
import { convertTimestampToISOWithFallback } from '../../utils.js';

export class DuckDBVSSManager implements IVSSManager {
  private connection: DuckDBConnection;
  private embeddingService: IEmbeddingService;
  private config: VSSConfig;
  private extensionLoaded: boolean = false;
  private indexesCreated: boolean = false;
  private lastHealthCheck: VSSHealthCheck | null = null;
  private entityEmbeddingsAvailable: boolean | null = null; // cache detection
  private searchStats = {
    totalSearches: 0,
    semanticSearches: 0,
    hybridSearches: 0,
    totalLatency: 0,
  };
  // If true, send embedding as string parameter ("[v1,...]") to work around binder issues
  private fallbackToStringParam: boolean = false;

  constructor(
    connection: DuckDBConnection,
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
      const useAux = await this.isEntityEmbeddingsAvailable();
      
      // 為 entities or entity_embeddings 建立 HNSW 索引
      if (useAux) {
        if (!existingIndexes.some(idx => idx.name === 'entity_embeddings_embedding_idx')) {
          await this.createAuxEntityEmbeddingIndex();
        }
      } else {
        if (!existingIndexes.some(idx => idx.name === 'entities_embedding_idx')) {
          await this.createEntityEmbeddingIndex();
        }
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
    // Runtime guard: ensure query embedding has expected dimension
    const expectedDim = this.getExpectedEmbeddingDimension();
    const embeddingLength = (queryEmbedding as any)?.length;
    if (!queryEmbedding || embeddingLength !== expectedDim) {
      logger.error('Invalid query embedding dimension', { expectedDim, length: embeddingLength });
      throw new (VSSError as any)(
        `Invalid query embedding dimension: expected ${expectedDim}, got ${embeddingLength}`,
        'EMBEDDING_DIMENSION_MISMATCH',
        true,
        false
      );
    }
    
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

    // Try with current parameter mode; if binder error due to FLOAT[] mismatch occurs, fallback once
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
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
          paramMode: this.fallbackToStringParam ? 'string' : 'array',
        });

        return results;
      } catch (error: any) {
        lastError = error;
        const message = (error && (error.message || String(error))) as string;
        const isBinderArrayMismatch =
          typeof message === 'string' &&
          message.includes('No function matches the given name') &&
          message.includes('array_cosine_similarity') &&
          message.includes('FLOAT[]');
        const isAnyTypeBindingIssue =
          typeof message === 'string' &&
          (message.includes('Cannot create values of type ANY') ||
           message.includes('createValue.js'));

        if (!this.fallbackToStringParam && (isBinderArrayMismatch || isAnyTypeBindingIssue)) {
          this.fallbackToStringParam = true;
          logger.warn('VSS query param fallback to string casting', {
            reason: isAnyTypeBindingIssue ? 'Node-API ANY type binding' : 'Binder mismatch with FLOAT[]',
            model: this.embeddingService.getConfig().model,
            expectedDim,
          });
          continue; // retry once with string parameter mode
        }

        logger.error('VSS search failed', { error, options });
        throw new (VSSError as any)(
          `VSS search failed: ${error}`,
          'VSS_SEARCH_FAILED',
          true,
          true
        );
      }
    }

    // Shouldn't reach here; throw last error as fallback
    throw new (VSSError as any)(
      `VSS search failed: ${lastError}`,
      'VSS_SEARCH_FAILED',
      true,
      true
    );
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
    const indexName = 'entities_embedding_idx';
    
    try {
      // 檢查索引是否已存在
      const existingIndexes = await this.getExistingIndexes();
      const indexExists = existingIndexes.some(index => index.name === indexName);
      
      if (indexExists) {
        logger.debug(`HNSW index ${indexName} already exists, skipping creation`);
        return;
      }
      
      // 創建 HNSW 索引
      const sql = `
        CREATE INDEX ${indexName} ON entities 
        USING HNSW (embedding) 
        WITH (metric = '${this.config.indexParams.metric}', 
              ef_construction = ${this.config.indexParams.efConstruction}, 
              M = ${this.config.indexParams.M});
      `;
      
      logger.debug(`Creating HNSW index ${indexName} for entities...`);
      await this.executeQuery(sql);
      logger.info(`HNSW index ${indexName} created successfully`);
      
    } catch (error) {
      // 如果錯誤是索引已存在，則視為成功（雙重保護）
      if (error instanceof Error && error.message.includes('already exists')) {
        logger.debug(`HNSW index ${indexName} already exists (detected in catch), continuing...`);
        return;
      }
      
      logger.error(`Failed to create HNSW index ${indexName}`, { 
        error: error instanceof Error ? error.message : String(error),
        indexName,
        metric: this.config.indexParams.metric,
        efConstruction: this.config.indexParams.efConstruction,
        M: this.config.indexParams.M
      });
      throw new Error(`Failed to create entity embedding HNSW index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createAuxEntityEmbeddingIndex(): Promise<void> {
    const indexName = 'entity_embeddings_embedding_idx';
    try {
      const existingIndexes = await this.getExistingIndexes();
      const indexExists = existingIndexes.some(index => index.name === indexName);
      if (indexExists) {
        logger.debug(`HNSW index ${indexName} already exists, skipping creation`);
        return;
      }

      const sql = `
        CREATE INDEX ${indexName} ON entity_embeddings 
        USING HNSW (embedding) 
        WITH (metric = '${this.config.indexParams.metric}', 
              ef_construction = ${this.config.indexParams.efConstruction}, 
              M = ${this.config.indexParams.M});
      `;

      logger.debug(`Creating HNSW index ${indexName} for entity_embeddings...`);
      await this.executeQuery(sql);
      logger.info(`HNSW index ${indexName} created successfully`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        logger.debug(`HNSW index ${indexName} already exists (detected in catch), continuing...`);
        return;
      }
      logger.error(`Failed to create HNSW index ${indexName}`, { 
        error: error instanceof Error ? error.message : String(error),
        indexName,
      });
      throw new Error(`Failed to create entity_embeddings HNSW index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createObservationEmbeddingIndex(): Promise<void> {
    const indexName = 'observations_embedding_idx';
    
    try {
      // 檢查索引是否已存在
      const existingIndexes = await this.getExistingIndexes();
      const indexExists = existingIndexes.some(index => index.name === indexName);
      
      if (indexExists) {
        logger.debug(`HNSW index ${indexName} already exists, skipping creation`);
        return;
      }
      
      // 創建 HNSW 索引
      const sql = `
        CREATE INDEX ${indexName} ON observations 
        USING HNSW (embedding) 
        WITH (metric = '${this.config.indexParams.metric}', 
              ef_construction = ${this.config.indexParams.efConstruction}, 
              M = ${this.config.indexParams.M});
      `;
      
      logger.debug(`Creating HNSW index ${indexName} for observations...`);
      await this.executeQuery(sql);
      logger.info(`HNSW index ${indexName} created successfully`);
      
    } catch (error) {
      // 如果錯誤是索引已存在，則視為成功（雙重保護）
      if (error instanceof Error && error.message.includes('already exists')) {
        logger.debug(`HNSW index ${indexName} already exists (detected in catch), continuing...`);
        return;
      }
      
      logger.error(`Failed to create HNSW index ${indexName}`, { 
        error: error instanceof Error ? error.message : String(error),
        indexName,
        metric: this.config.indexParams.metric,
        efConstruction: this.config.indexParams.efConstruction,
        M: this.config.indexParams.M
      });
      throw new Error(`Failed to create observation embedding HNSW index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async searchEntitiesWithVSS(
    queryEmbedding: EmbeddingVector,
    options: VSSSearchOptions
  ): Promise<VSSSearchResult[]> {
    const expectedDim = this.getExpectedEmbeddingDimension();
    const useAux = await this.isAuxSearchable();
    let sql = '';
    if (useAux) {
      sql = `
        SELECT e.name, e.entityType, e.created_at AS createdAt, ee.embedding,
               array_cosine_similarity(ee.embedding, $1::FLOAT[${expectedDim}]) as similarity
        FROM entity_embeddings ee
        JOIN entities e ON ee.name = e.name
        WHERE ee.embedding IS NOT NULL
          AND len(ee.embedding) > 0
          AND array_cosine_similarity(ee.embedding, $1::FLOAT[${expectedDim}]) >= $2
      `;
    } else {
      sql = `
        SELECT e.name, e.entityType, e.created_at AS createdAt, e.embedding,
               array_cosine_similarity(e.embedding, $1::FLOAT[${expectedDim}]) as similarity
        FROM entities e
        WHERE e.embedding IS NOT NULL
          AND len(e.embedding) > 0
          AND array_cosine_similarity(e.embedding, $1::FLOAT[${expectedDim}]) >= $2
      `;
    }

    const params: any[] = [this.formatEmbeddingParam(queryEmbedding), options.threshold || 0.7];
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
      const result = await this.executeQuery(sql, params);
      const rowsArray: any[] = Array.isArray(result)
        ? result
        : (typeof result?.getRows === 'function' ? result.getRows() : []);

      return rowsArray.map((row: any) => {
        // Support both object rows and array rows
        const name = Array.isArray(row) ? row[0] : row.name;
        const entityType = Array.isArray(row) ? row[1] : row.entityType;
        const createdAtRaw = Array.isArray(row) ? row[2] : row.createdAt;
        const embedding = Array.isArray(row) ? row[3] : row.embedding;
        const similarity = Array.isArray(row) ? row[4] : row.similarity;
        return {
          entity: {
            name,
            entityType,
            observations: [],
            createdAt: convertTimestampToISOWithFallback(createdAtRaw),
          },
          similarity,
          matchSource: 'entity' as const,
          embedding: options.includeEmbeddings ? embedding : undefined,
        };
      });
    } catch (error) {
      logger.error('Entity VSS search failed', { error });
      throw error;
    }
  }

  private async searchObservationsWithVSS(
    queryEmbedding: EmbeddingVector,
    options: VSSSearchOptions
  ): Promise<VSSSearchResult[]> {
    const expectedDim = this.getExpectedEmbeddingDimension();
    let sql = `
      SELECT o.entityName, o.content, e.created_at AS createdAt, o.embedding,
             e.entityType,
             array_cosine_similarity(o.embedding, $1::FLOAT[${expectedDim}]) as similarity
      FROM observations o
      JOIN entities e ON o.entityName = e.name
      WHERE o.embedding IS NOT NULL
        AND len(o.embedding) > 0
        AND array_cosine_similarity(o.embedding, $1::FLOAT[${expectedDim}]) >= $2
    `;

    const params: any[] = [this.formatEmbeddingParam(queryEmbedding), options.threshold || 0.7];
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
      const result = await this.executeQuery(sql, params);
      const rowsArray: any[] = Array.isArray(result)
        ? result
        : (typeof result?.getRows === 'function' ? result.getRows() : []);

      return rowsArray.map((row: any) => {
        const entityName = Array.isArray(row) ? row[0] : row.entityName;
        const content = Array.isArray(row) ? row[1] : row.content;
        const createdAtRaw = Array.isArray(row) ? row[2] : row.createdAt;
        const embedding = Array.isArray(row) ? row[3] : row.embedding;
        const entityType = Array.isArray(row) ? row[4] : row.entityType;
        const similarity = Array.isArray(row) ? row[5] : row.similarity;
        return {
          entity: {
            name: entityName,
            entityType,
            observations: [],
            createdAt: convertTimestampToISOWithFallback(createdAtRaw),
          },
          similarity,
          matchSource: 'observation' as const,
          matchedContent: content,
          embedding: options.includeEmbeddings ? embedding : undefined,
        };
      });
    } catch (error) {
      logger.error('Observation VSS search failed', { error });
      throw error;
    }
  }

  private getExpectedEmbeddingDimension(): number {
    try {
      const model = this.embeddingService.getConfig().model;
      return getModelDimensions(model);
    } catch {
      return 1536;
    }
  }

  private formatEmbeddingParam(embedding: EmbeddingVector): any {
    if (!this.fallbackToStringParam) {
      return embedding;
    }
    const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
    return '[' + embeddingArray.join(',') + ']';
  }

  // Aux 是否可搜尋：表存在且至少有一筆有效向量（長度符合期望）
  private async isAuxSearchable(): Promise<boolean> {
    // 先確認表存在
    const exists = await this.isEntityEmbeddingsAvailable();
    if (!exists) return false;
    // 檢查是否有至少一筆有效向量
    const expected = this.getExpectedEmbeddingDimension();
    try {
      const rows = await this.executeQuery(
        `SELECT 1 FROM entity_embeddings WHERE embedding IS NOT NULL AND array_length(embedding, 1) = $1 LIMIT 1`,
        [expected]
      );
      const hasRow = Array.isArray(rows)
        ? rows.length > 0
        : (typeof rows?.getRows === 'function' ? rows.getRows().length > 0 : false);
      return hasRow;
    } catch (err) {
      // 如果查詢失敗，保守回退為不可搜尋
      return false;
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
    const expectedDim = this.getExpectedEmbeddingDimension();
    const useAux = await this.isEntityEmbeddingsAvailable();
    // Runtime guard: ensure embedding dimension is correct before write
    if (!embedding || (embedding as any).length !== expectedDim) {
      logger.error('Invalid entity embedding dimension', { expectedDim, length: (embedding as any)?.length, entityName });
      throw new Error(`Invalid entity embedding dimension: expected ${expectedDim}, got ${(embedding as any)?.length}`);
    }
    if (useAux) {
      const sqlAux = `
        INSERT INTO entity_embeddings(name, embedding, embedding_model, embedding_updated_at)
        VALUES ($2, $1::FLOAT[${expectedDim}], $3, CURRENT_TIMESTAMP)
        ON CONFLICT (name) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          embedding_updated_at = EXCLUDED.embedding_updated_at
      `;
      await this.executeQuery(sqlAux, [
        embedding,
        entityName,
        this.embeddingService.getConfig().model
      ]);
    } else {
      const sql = `
        UPDATE entities 
        SET embedding = $1::FLOAT[${expectedDim}], 
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
      // 使用更簡單可靠的查詢方式
      const result = await this.executeQuery(`
        SELECT index_name as name 
        FROM duckdb_indexes() 
        WHERE index_name LIKE '%embedding%'
      `);
      
      // 使用標準陣列格式處理結果（與其他地方保持一致）
      const indexes: Array<{ name: string }> = [];
      
      if (result && typeof result.getRows === 'function') {
        // DuckDB result format with getRows() method
        const rows = result.getRows();
        for (const row of rows) {
          if (row && row.length > 0 && row[0]) {
            indexes.push({ name: row[0] });
          }
        }
      } else if (result && Array.isArray(result)) {
        // Direct array result format
        for (const row of result) {
          if (row && row.name) {
            indexes.push({ name: row.name });
          }
        }
      }
      
      logger.debug(`Found existing indexes: ${indexes.map(i => i.name).join(', ') || 'none'}`);
      return indexes;
    } catch (error) {
      logger.error('Failed to get existing indexes, will attempt individual checks', { error });
      
      // 改用個別檢查的方式，更可靠
      return await this.checkIndexesIndividually();
    }
  }

  private async checkIndexesIndividually(): Promise<Array<{ name: string }>> {
    const indexesToCheck = ['entities_embedding_idx', 'observations_embedding_idx'];
    const existingIndexes: Array<{ name: string }> = [];
    
    for (const indexName of indexesToCheck) {
      try {
        // 使用更直接的查詢方式
        const result = await this.executeQuery(`
          SELECT 1 FROM duckdb_indexes() WHERE index_name = $1
        `, [indexName]);
        
        // 如果查詢有結果，表示索引存在
        const hasResult = result && (
          (typeof result.getRows === 'function' && result.getRows().length > 0) ||
          (Array.isArray(result) && result.length > 0)
        );
        
        if (hasResult) {
          existingIndexes.push({ name: indexName });
          logger.debug(`Index ${indexName} exists`);
        } else {
          logger.debug(`Index ${indexName} does not exist`);
        }
      } catch (error) {
        logger.debug(`Failed to check index ${indexName}, assuming it doesn't exist`, { error });
      }
    }
    
    return existingIndexes;
  }

  private async getIndexStatuses(): Promise<VSSIndexStatus[]> {
    const expectedDim = this.getExpectedEmbeddingDimension();
    const statuses: VSSIndexStatus[] = [];
    
    try {
      const existingIndexes = await this.getExistingIndexes();
      logger.debug(`Found ${existingIndexes.length} VSS indexes for health check`);
      const useAux = await this.isEntityEmbeddingsAvailable();
      
      // 檢查 entity 向量索引（aux 優先）
      if (useAux) {
        const auxIndexExists = existingIndexes.some(idx => idx.name === 'entity_embeddings_embedding_idx');
        if (auxIndexExists) {
          const entityCount = await this.countEntitiesWithEmbeddings();
          const totalEntities = await this.countTotalEntities();
          statuses.push({
            name: 'entity_embeddings_embedding_idx',
            table: 'entity_embeddings',
            column: 'embedding',
            indexType: 'HNSW',
            metric: this.config.indexParams.metric,
            dimensions: expectedDim,
            totalVectors: entityCount,
            parameters: {
              ...this.config.indexParams,
              coverage: totalEntities > 0 ? (entityCount / totalEntities * 100).toFixed(1) + '%' : '0%',
              totalRows: totalEntities,
            },
            isHealthy: await this.checkIndexHealth('entity_embeddings_embedding_idx', 'entity_embeddings'),
            lastUpdated: new Date().toISOString(),
          });
        }
      } else {
        const entitiesIndexExists = existingIndexes.some(idx => idx.name === 'entities_embedding_idx');
        if (entitiesIndexExists) {
          const entityCount = await this.countEntitiesWithEmbeddings();
          const totalEntities = await this.countTotalEntities();
          statuses.push({
            name: 'entities_embedding_idx',
            table: 'entities',
            column: 'embedding',
            indexType: 'HNSW',
            metric: this.config.indexParams.metric,
            dimensions: expectedDim,
            totalVectors: entityCount,
            parameters: {
              ...this.config.indexParams,
              coverage: totalEntities > 0 ? (entityCount / totalEntities * 100).toFixed(1) + '%' : '0%',
              totalRows: totalEntities,
            },
            isHealthy: await this.checkIndexHealth('entities_embedding_idx', 'entities'),
            lastUpdated: new Date().toISOString(),
          });
        }
      }
      
      // 檢查 observations 索引
      const observationsIndexExists = existingIndexes.some(idx => idx.name === 'observations_embedding_idx');
      if (observationsIndexExists) {
        const observationCount = await this.countObservationsWithEmbeddings();
        const totalObservations = await this.countTotalObservations();
        
        statuses.push({
          name: 'observations_embedding_idx',
          table: 'observations',
          column: 'embedding',
          indexType: 'HNSW',
          metric: this.config.indexParams.metric,
          dimensions: expectedDim,
          totalVectors: observationCount,
          parameters: {
            ...this.config.indexParams,
            coverage: totalObservations > 0 ? (observationCount / totalObservations * 100).toFixed(1) + '%' : '0%',
            totalRows: totalObservations,
          },
          isHealthy: await this.checkIndexHealth('observations_embedding_idx', 'observations'),
          lastUpdated: new Date().toISOString(),
        });
      }
      
      logger.debug(`Generated ${statuses.length} index status reports`);
      return statuses;
      
    } catch (error) {
      logger.error('Failed to get comprehensive index statuses', { error });
      
      // 降級到簡化版本，提供基本資訊
      return [
        {
          name: 'entities_embedding_idx',
          table: 'entities',
          column: 'embedding',
          indexType: 'HNSW',
          metric: this.config.indexParams.metric,
          dimensions: expectedDim,
          totalVectors: await this.countEntitiesWithEmbeddings().catch(() => 0),
          parameters: { ...this.config.indexParams, error: 'Status check failed' },
          isHealthy: false,
          lastUpdated: new Date().toISOString(),
        },
      ];
    }
  }

  private async countEntitiesWithEmbeddings(): Promise<number> {
    const useAux = await this.isEntityEmbeddingsAvailable();
    if (useAux) {
      const result = await this.executeQuery('SELECT COUNT(*) as count FROM entity_embeddings WHERE embedding IS NOT NULL');
      return result[0]?.count || 0;
    } else {
      const result = await this.executeQuery('SELECT COUNT(*) as count FROM entities WHERE embedding IS NOT NULL');
      return result[0]?.count || 0;
    }
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

  private async checkIndexHealth(indexName: string, tableName: string): Promise<boolean> {
    try {
      // 檢查索引是否存在於系統表中
      const indexExists = await this.executeQuery(`
        SELECT 1 FROM duckdb_indexes() 
        WHERE index_name = $1 AND table_name = $2
      `, [indexName, tableName]);
      
      if (!indexExists || (Array.isArray(indexExists) && indexExists.length === 0)) {
        logger.debug(`Index ${indexName} does not exist in system catalog`);
        return false;
      }
      
      // 嘗試使用索引執行簡單查詢來驗證索引功能
      const testQuery = tableName === 'entities' 
        ? 'SELECT COUNT(*) FROM entities WHERE embedding IS NOT NULL LIMIT 1'
        : 'SELECT COUNT(*) FROM observations WHERE embedding IS NOT NULL LIMIT 1';
      
      await this.executeQuery(testQuery);
      
      logger.debug(`Index ${indexName} health check passed`);
      return true;
      
    } catch (error) {
      logger.warn(`Index ${indexName} health check failed`, { 
        error: error instanceof Error ? error.message : String(error),
        indexName,
        tableName 
      });
      return false;
    }
  }

  /**
   * 獲取詳細的 VSS 診斷資訊，用於故障排查
   */
  async getVSSDiagnostics(): Promise<{
    systemInfo: Record<string, any>;
    indexInfo: Array<{ name: string; exists: boolean; details?: any; error?: string }>;
    embeddingStats: Record<string, number>;
    recommendations: string[];
    issues: string[];
  }> {
    const diagnostics = {
      systemInfo: {},
      indexInfo: [],
      embeddingStats: {},
      recommendations: [],
      issues: [],
    } as any;

    try {
      // 系統資訊
      diagnostics.systemInfo = {
        vssEnabled: this.config.enabled,
        vssConfig: this.config,
        extensionLoaded: await this.checkVSSExtension(),
        timestamp: new Date().toISOString(),
      };

      // 檢查所有預期的索引
      const expectedIndexes = [
        { name: 'entities_embedding_idx', table: 'entities' },
        { name: 'observations_embedding_idx', table: 'observations' },
      ];

      for (const { name, table } of expectedIndexes) {
        try {
          const exists = await this.checkIndexHealth(name, table);
          const details: any = { table, exists };

          if (exists) {
            // 獲取索引詳細資訊
            const indexDetails = await this.executeQuery(`
              SELECT index_name, table_name, is_unique, sql 
              FROM duckdb_indexes() 
              WHERE index_name = $1
            `, [name]).catch(() => null);

            if (indexDetails && indexDetails.length > 0) {
              details.indexDetails = indexDetails[0];
            }
          }

          diagnostics.indexInfo.push({ name, exists, details });

        } catch (error) {
          diagnostics.indexInfo.push({
            name,
            exists: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 嵌入統計
      try {
        const [entitiesWithEmbeddings, totalEntities, observationsWithEmbeddings, totalObservations] =
          await Promise.all([
            this.countEntitiesWithEmbeddings(),
            this.countTotalEntities(),
            this.countObservationsWithEmbeddings(),
            this.countTotalObservations(),
          ]);

        diagnostics.embeddingStats = {
          entitiesWithEmbeddings,
          totalEntities,
          entitiesCoverage: totalEntities > 0 ? (entitiesWithEmbeddings / totalEntities * 100) : 0,
          observationsWithEmbeddings,
          totalObservations,
          observationsCoverage: totalObservations > 0 ? (observationsWithEmbeddings / totalObservations * 100) : 0,
        };

        // 生成建議
        if (entitiesWithEmbeddings === 0 && totalEntities > 0) {
          diagnostics.recommendations.push('建議執行 embedding backfill 工具為現有實體生成向量');
        }

        if (observationsWithEmbeddings === 0 && totalObservations > 0) {
          diagnostics.recommendations.push('建議執行 embedding backfill 工具為現有觀察生成向量');
        }

        const totalVectors = entitiesWithEmbeddings + observationsWithEmbeddings;
        if (totalVectors > 0) {
          const recommendedParams = this.recommendHNSWParameters(totalVectors);
          if (
            this.config.indexParams.efConstruction !== recommendedParams.efConstruction ||
            this.config.indexParams.M !== recommendedParams.M
          ) {
            diagnostics.recommendations.push(
              `根據 ${totalVectors} 個向量，建議使用 HNSW 參數：efConstruction=${recommendedParams.efConstruction}, M=${recommendedParams.M}`
            );
          }
        }

      } catch (error) {
        diagnostics.issues.push(`無法獲取嵌入統計：${error instanceof Error ? error.message : String(error)}`);
      }

      // 系統健康檢查問題
      const healthCheck = await this.checkHealth();
      if (healthCheck.issues.length > 0) {
        diagnostics.issues.push(...healthCheck.issues);
      }

      return diagnostics;

    } catch (error) {
      logger.error('VSS diagnostics failed', { error });
      diagnostics.issues.push(`診斷程序失敗：${error instanceof Error ? error.message : String(error)}`);
      return diagnostics;
    }
  }

  private recommendHNSWParameters(vectorCount: number): { efConstruction: number; M: number } {
    if (vectorCount < 10000) {
      return { efConstruction: 100, M: 8 };
    } else if (vectorCount < 100000) {
      return { efConstruction: 200, M: 16 };
    } else {
      return { efConstruction: 400, M: 32 };
    }
  }

  private async dropExistingIndexes(): Promise<void> {
    const indexes = ['entities_embedding_idx', 'entity_embeddings_embedding_idx', 'observations_embedding_idx'];
    
    for (const indexName of indexes) {
      try {
        await this.executeQuery(`DROP INDEX IF EXISTS ${indexName}`);
      } catch (error) {
        logger.warn(`Failed to drop index ${indexName}`, { error });
      }
    }
  }

  private async cleanupInvalidEntityEmbeddings(): Promise<void> {
    const useAux = await this.isEntityEmbeddingsAvailable();
    if (useAux) {
      await this.executeQuery(`
        UPDATE entity_embeddings 
        SET embedding = NULL, embedding_updated_at = NULL 
        WHERE embedding IS NOT NULL 
          AND (array_length(embedding, 1) = 0 OR embedding IS NULL)
      `);
    } else {
      await this.executeQuery(`
        UPDATE entities 
        SET embedding = NULL, embedding_updated_at = NULL 
        WHERE embedding IS NOT NULL 
          AND (array_length(embedding, 1) = 0 OR embedding IS NULL)
      `);
    }
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

  private async isEntityEmbeddingsAvailable(): Promise<boolean> {
    if (this.entityEmbeddingsAvailable !== null) return this.entityEmbeddingsAvailable;
    try {
      const rows = await this.executeQuery(`
        SELECT 1 FROM duckdb_tables() WHERE table_name = 'entity_embeddings' LIMIT 1
      `);
      const exists = Array.isArray(rows) ? rows.length > 0 : (typeof rows.getRows === 'function' ? rows.getRows().length > 0 : false);
      this.entityEmbeddingsAvailable = exists;
      return exists;
    } catch {
      this.entityEmbeddingsAvailable = false;
      return false;
    }
  }
}