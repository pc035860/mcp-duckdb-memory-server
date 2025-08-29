import type { Logger } from '../../logger.js';
import type { IEmbeddingService, EmbeddingVector } from '../../types/embedding.js';
import type { Entity } from '../../types.js';
import { extractError } from '../../utils.js';

export interface EmbeddingQueueConfig {
  debounceMs: number;
  batchSize: number;
  maxRetries: number;
  autoGenerate: boolean;
}

export interface EmbeddingQueueCallbacks {
  getConnection: () => Promise<any>;
  isVSSAvailable: () => boolean;
  isEntityEmbeddingsAvailable: () => Promise<boolean>;
}

export class EmbeddingQueueManager {
  private config: EmbeddingQueueConfig;
  private logger: Logger;
  private callbacks: EmbeddingQueueCallbacks;
  private embeddingService: IEmbeddingService | null;

  // Queue management
  private embeddingQueue: Set<string> = new Set(); // entities awaiting embedding
  private observationQueue: Set<number> = new Set(); // observations awaiting embedding
  private embeddingTimer: NodeJS.Timeout | null = null;

  constructor(
    config: EmbeddingQueueConfig,
    callbacks: EmbeddingQueueCallbacks,
    logger: Logger,
    embeddingService: IEmbeddingService | null = null
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.logger = logger;
    this.embeddingService = embeddingService;
  }

  /**
   * Set or update the embedding service
   */
  setEmbeddingService(service: IEmbeddingService | null): void {
    this.embeddingService = service;
  }

  /**
   * Add entity names to the embedding queue
   */
  addEntitiesToQueue(entityNames: string[]): void {
    const initialSize = this.embeddingQueue.size;
    entityNames.forEach(name => this.embeddingQueue.add(name));
    
    if (this.embeddingQueue.size > initialSize) {
      this.logger.debug(`Added ${this.embeddingQueue.size - initialSize} entities to embedding queue`, {
        totalInQueue: this.embeddingQueue.size
      });
    }
  }

  /**
   * Add observation IDs to the embedding queue
   */
  addObservationsToQueue(observationIds: number[]): void {
    const initialSize = this.observationQueue.size;
    observationIds.forEach(id => this.observationQueue.add(id));
    
    if (this.observationQueue.size > initialSize) {
      this.logger.debug(`Added ${this.observationQueue.size - initialSize} observations to embedding queue`, {
        totalInQueue: this.observationQueue.size
      });
    }
  }

  /**
   * Schedule embedding generation with debounce
   */
  async scheduleEmbeddingGeneration(): Promise<void> {
    // Skip if embedding auto-generation is disabled
    if (!this.config.autoGenerate) {
      this.logger.debug("Embedding auto-generation disabled, skipping embedding generation scheduling");
      return;
    }

    // Skip if VSS services are not available
    if (!this.callbacks.isVSSAvailable()) {
      this.logger.debug("VSS services not available, skipping embedding generation scheduling");
      return;
    }

    // Skip if no items in queue
    if (this.embeddingQueue.size === 0 && this.observationQueue.size === 0) {
      this.logger.debug("No items in embedding queues, skipping embedding generation scheduling");
      return;
    }

    try {
      // Clear any existing timer to reset the debounce
      if (this.embeddingTimer) {
        clearTimeout(this.embeddingTimer);
        this.embeddingTimer = null;
        this.logger.debug("Previous embedding generation timer cleared, resetting debounce");
      }

      // Schedule new embedding generation with debounce
      this.embeddingTimer = setTimeout(async () => {
        try {
          this.logger.debug(`Debounce timer expired, starting embedding generation. Queue sizes: entities=${this.embeddingQueue.size}, observations=${this.observationQueue.size}`);
          await this.processEmbeddingQueue();
          this.embeddingTimer = null;
          this.logger.info("Scheduled embedding generation completed successfully");
        } catch (error) {
          this.embeddingTimer = null;
          // Log error but don't throw to prevent disrupting the main flow
          this.logger.error("Failed to generate embeddings in scheduled task", extractError(error));
        }
      }, this.config.debounceMs);

      this.logger.debug(`Embedding generation scheduled with ${this.config.debounceMs}ms debounce`);
    } catch (error) {
      // Handle any timer-related errors gracefully
      this.logger.error("Error scheduling embedding generation", extractError(error));
    }
  }

  /**
   * Process queued entities and observations for embedding generation
   * Uses batch processing to improve efficiency and reduce API costs
   */
  private async processEmbeddingQueue(): Promise<void> {
    const startTime = Date.now();
    const entityNames = Array.from(this.embeddingQueue);
    const observationIds = Array.from(this.observationQueue);
    
    this.logger.debug(`Processing embedding queue: ${entityNames.length} entities, ${observationIds.length} observations`);

    // Clear queues early to prevent duplicate processing
    this.embeddingQueue.clear();
    this.observationQueue.clear();

    let processedEntities = 0;
    let processedObservations = 0;
    let totalTokens = 0;

    try {
      // Process entities in batches
      if (entityNames.length > 0) {
        const entityResult = await this.processEntityBatch(entityNames);
        processedEntities = entityResult.processed;
        totalTokens += entityResult.tokens;
      }

      // Process observations in batches
      if (observationIds.length > 0) {
        const observationResult = await this.processObservationBatch(observationIds);
        processedObservations = observationResult.processed;
        totalTokens += observationResult.tokens;
      }

      const duration = Date.now() - startTime;
      this.logger.info("Embedding queue processing completed", {
        processedEntities,
        processedObservations,
        totalTokens,
        durationMs: duration,
      });

    } catch (error) {
      // Re-queue items that failed to process
      entityNames.forEach(name => this.embeddingQueue.add(name));
      observationIds.forEach(id => this.observationQueue.add(id));
      
      this.logger.error("Failed to process embedding queue", {
        error: extractError(error),
        entityCount: entityNames.length,
        observationCount: observationIds.length,
      });
      throw error;
    }
  }

  /**
   * Process a batch of entities for embedding generation
   */
  private async processEntityBatch(entityNames: string[]): Promise<{ processed: number; tokens: number }> {
    if (entityNames.length === 0) return { processed: 0, tokens: 0 };
    if (!this.embeddingService) {
      this.logger.warn("Embedding service not available for entity batch processing");
      return { processed: 0, tokens: 0 };
    }

    this.logger.debug(`Processing entity batch: ${entityNames.length} entities`);

    try {
      // Fetch entity data from database
      const entities = await this.getEntitiesByNames(entityNames);
      if (entities.length === 0) {
        this.logger.warn("No entities found for the provided names", { entityNames });
        return { processed: 0, tokens: 0 };
      }

      // Process entities in smaller batches to respect API limits
      let totalProcessed = 0;
      let totalTokens = 0;

      for (let i = 0; i < entities.length; i += this.config.batchSize) {
        const batch = entities.slice(i, i + this.config.batchSize);
        
        // Prepare text for embedding
        const textsToEmbed = batch.map(entity => this.prepareEntityTextForEmbedding(entity));
        
        // Generate embeddings
        const batchResult = await this.embeddingService.generateBatchEmbeddings(textsToEmbed);
        
        // Update database with embeddings
        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const embedding = batchResult.embeddings[j];
          await this.updateEntityEmbeddingInDB(entity.name, embedding.vector);
        }

        totalProcessed += batch.length;
        totalTokens += batchResult.totalUsage.totalTokens;
      }

      this.logger.debug(`Entity batch processing completed: ${totalProcessed} entities processed`);
      return { processed: totalProcessed, tokens: totalTokens };

    } catch (error) {
      this.logger.error("Failed to process entity batch", {
        error: extractError(error),
        entityNames,
      });
      throw error;
    }
  }

  /**
   * Process a batch of observations for embedding generation
   */
  private async processObservationBatch(observationIds: number[]): Promise<{ processed: number; tokens: number }> {
    if (observationIds.length === 0) return { processed: 0, tokens: 0 };
    if (!this.embeddingService) {
      this.logger.warn("Embedding service not available for observation batch processing");
      return { processed: 0, tokens: 0 };
    }

    this.logger.debug(`Processing observation batch: ${observationIds.length} observations`);

    try {
      // Fetch observation data from database
      const observations = await this.getObservationsByIds(observationIds);
      if (observations.length === 0) {
        this.logger.warn("No observations found for the provided IDs", { observationIds });
        return { processed: 0, tokens: 0 };
      }

      // Process observations in smaller batches to respect API limits
      let totalProcessed = 0;
      let totalTokens = 0;

      for (let i = 0; i < observations.length; i += this.config.batchSize) {
        const batch = observations.slice(i, i + this.config.batchSize);
        
        // Use observation content directly for embedding
        const textsToEmbed = batch.map(obs => obs.content);
        
        // Generate embeddings
        const batchResult = await this.embeddingService.generateBatchEmbeddings(textsToEmbed);
        
        // Update database with embeddings
        for (let j = 0; j < batch.length; j++) {
          const observation = batch[j];
          const embedding = batchResult.embeddings[j];
          await this.updateObservationEmbeddingInDB(observation.id, embedding.vector);
        }

        totalProcessed += batch.length;
        totalTokens += batchResult.totalUsage.totalTokens;
      }

      this.logger.debug(`Observation batch processing completed: ${totalProcessed} observations processed`);
      return { processed: totalProcessed, tokens: totalTokens };

    } catch (error) {
      this.logger.error("Failed to process observation batch", {
        error: extractError(error),
        observationIds,
      });
      throw error;
    }
  }

  /**
   * Get entities by names from database
   */
  private async getEntitiesByNames(names: string[]): Promise<Entity[]> {
    if (names.length === 0) return [];
    
    const connection = await this.callbacks.getConnection();
    const placeholders = names.map((_, i) => `$${i + 1}`).join(',');
    // Use the same query pattern as DuckDBManager.getAllEntities()
    const sql = `
      SELECT e.name, e.entityType, e.created_at, o.content
      FROM entities e
      LEFT JOIN observations o ON e.name = o.entityName
      WHERE e.name IN (${placeholders})
    `;
    
    const result = await connection.runAndReadAll(sql, names);
    const rawRows = result.getRows();
    
    // Group observations by entity
    const entitiesMap = new Map<string, Entity>();
    
    for (const row of rawRows) {
      const name = row[0] as string;
      const entityType = row[1] as string;
      const created_at = row[2];
      const content = row[3] as string | null;
      
      if (!entitiesMap.has(name)) {
        entitiesMap.set(name, {
          name,
          entityType,
          createdAt: created_at instanceof Date ? created_at.toISOString() : created_at,
          observations: content ? [content] : [],
        });
      } else if (content) {
        entitiesMap.get(name)!.observations.push(content);
      }
    }
    
    const rows = Array.from(entitiesMap.values());
    
    return rows;
  }

  /**
   * Get observations by IDs from database
   */
  private async getObservationsByIds(ids: number[]): Promise<Array<{ id: number; content: string }>> {
    if (ids.length === 0) return [];
    
    const connection = await this.callbacks.getConnection();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const sql = `
      SELECT id, content
      FROM observations 
      WHERE id IN (${placeholders})
    `;
    
    const result = await connection.runAndReadAll(sql, ids);
    let rows: any[] = [];
    
    // Handle different DuckDB result formats
    if (result && typeof result.getRows === 'function') {
      const rawRows = result.getRows();
      rows = rawRows.map((row: any[]) => ({
        id: row[0],
        content: row[1],
      }));
    } else if (Array.isArray(result)) {
      rows = result.map((row: any) => ({
        id: row.id,
        content: row.content,
      }));
    }
    
    return rows;
  }

  /**
   * Prepare entity text for embedding generation
   */
  private prepareEntityTextForEmbedding(entity: Entity): string {
    const parts = [
      entity.name,
      entity.entityType,
      ...(entity.observations || [])
    ];
    return parts.join(' ');
  }

  /**
   * Update entity embedding in database (supports Strategy C)
   */
  private async updateEntityEmbeddingInDB(entityName: string, embedding: EmbeddingVector): Promise<void> {
    const connection = await this.callbacks.getConnection();
    const useAux = await this.callbacks.isEntityEmbeddingsAvailable();
    
    // Debug logging for embedding vector format
    this.logger.debug("updateEntityEmbeddingInDB: embedding vector details", {
      entityName,
      embeddingType: embedding.constructor.name,
      embeddingLength: embedding.length,
      isArray: Array.isArray(embedding),
      sampleValues: embedding.slice(0, 5),
      useAux
    });
    
    // Convert embedding to string format (like backfill-embeddings.ts does)
    let embeddingStr: string;
    try {
      const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
      embeddingStr = '[' + embeddingArray.join(',') + ']';
      this.logger.debug("Embedding string conversion", {
        originalType: embedding.constructor.name,
        arrayLength: embeddingArray.length,
        stringFormat: `${embeddingStr.substring(0, 20)}...${embeddingStr.substring(embeddingStr.length - 10)}`
      });
    } catch (conversionError) {
      this.logger.error("Failed to convert embedding to string format", { error: conversionError });
      throw conversionError;
    }
    
    if (useAux) {
      // Use auxiliary entity_embeddings table (Strategy C)
      const sqlAux = `
        INSERT INTO entity_embeddings(name, embedding, embedding_model, embedding_updated_at)
        VALUES ($1, $2::FLOAT[], $3, CURRENT_TIMESTAMP)
        ON CONFLICT (name) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          embedding_updated_at = EXCLUDED.embedding_updated_at
      `;
      
      this.logger.debug("Executing auxiliary table SQL", { sql: sqlAux, entityName, embeddingStringLength: embeddingStr.length });
      await connection.runAndReadAll(sqlAux, [
        entityName,
        embeddingStr,
        this.embeddingService!.getConfig().model
      ]);
    } else {
      // Update entities table directly
      const sql = `
        UPDATE entities 
        SET embedding = $2::FLOAT[], 
            embedding_updated_at = CURRENT_TIMESTAMP,
            embedding_model = $3
        WHERE name = $1
      `;
      
      this.logger.debug("Executing entities table SQL", { sql, entityName, embeddingStringLength: embeddingStr.length });
      await connection.runAndReadAll(sql, [
        entityName,
        embeddingStr,
        this.embeddingService!.getConfig().model
      ]);
    }
  }

  /**
   * Update observation embedding in database
   */
  private async updateObservationEmbeddingInDB(observationId: number, embedding: EmbeddingVector): Promise<void> {
    const connection = await this.callbacks.getConnection();
    
    // Debug logging for embedding vector format
    this.logger.debug("updateObservationEmbeddingInDB: embedding vector details", {
      observationId,
      embeddingType: embedding.constructor.name,
      embeddingLength: embedding.length,
      isArray: Array.isArray(embedding),
      sampleValues: embedding.slice(0, 5)
    });
    
    // Convert embedding to string format (like backfill-embeddings.ts does)
    let embeddingStr: string;
    try {
      const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
      embeddingStr = '[' + embeddingArray.join(',') + ']';
      this.logger.debug("Observation embedding string conversion", {
        originalType: embedding.constructor.name,
        arrayLength: embeddingArray.length,
        stringFormat: `${embeddingStr.substring(0, 20)}...${embeddingStr.substring(embeddingStr.length - 10)}`
      });
    } catch (conversionError) {
      this.logger.error("Failed to convert observation embedding to string format", { error: conversionError });
      throw conversionError;
    }
    
    const sql = `
      UPDATE observations 
      SET embedding = $1::FLOAT[1536],
          embedding_updated_at = CURRENT_TIMESTAMP,
          embedding_model = $3
      WHERE id = $2
    `;
    
    this.logger.debug("Executing observation SQL", { sql, observationId, embeddingStringLength: embeddingStr.length });
    await connection.runAndReadAll(sql, [
      embeddingStr,
      observationId,
      this.embeddingService!.getConfig().model
    ]);
  }

  /**
   * Get queue status for diagnostics
   */
  getQueueStatus(): {
    entityQueueSize: number;
    observationQueueSize: number;
    isScheduled: boolean;
    config: EmbeddingQueueConfig;
  } {
    return {
      entityQueueSize: this.embeddingQueue.size,
      observationQueueSize: this.observationQueue.size,
      isScheduled: this.embeddingTimer !== null,
      config: { ...this.config },
    };
  }

  /**
   * Clean up timers on shutdown
   */
  cleanup(): void {
    if (this.embeddingTimer) {
      clearTimeout(this.embeddingTimer);
      this.embeddingTimer = null;
      this.logger.debug("EmbeddingQueueManager cleanup: timer cleared");
    }
  }
}