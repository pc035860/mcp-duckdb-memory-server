import {
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  MultiKeywordSearchOptions,
  SearchNodesOptions,
} from "../types";
import { KnowledgeGraphManagerInterface } from "./interface";
import { IPCSocketClient } from "../servers/ipc/socket-client";
import { Logger } from "../logger";
import { extractError } from "../utils";

/**
 * Proxy manager that forwards requests to main server via IPC
 */
export class ProxyKnowledgeGraphManager implements KnowledgeGraphManagerInterface {
  private client: IPCSocketClient;
  private logger: Logger;
  private initialized: boolean = false;
  
  // Operation queue for serializing critical operations
  private operationQueue: Array<{
    operation: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private processingQueue: boolean = false;

  constructor(socketPath: string, logger: Logger) {
    this.client = new IPCSocketClient(socketPath, logger);
    this.logger = logger;
  }
  
  /**
   * Execute operation with local concurrency control
   * This ensures operations are serialized at the secondary server level
   */
  private async executeWithConcurrencyControl<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      // Add to operation queue
      this.operationQueue.push({
        operation,
        resolve,
        reject,
      });
      
      // Start processing queue if not already processing
      if (!this.processingQueue) {
        this.processOperationQueue();
      }
    });
  }
  
  /**
   * Process operation queue sequentially
   */
  private async processOperationQueue(): Promise<void> {
    if (this.processingQueue || this.operationQueue.length === 0) {
      return;
    }
    
    this.processingQueue = true;
    this.logger.debug("Started processing proxy operation queue");
    
    while (this.operationQueue.length > 0) {
      const item = this.operationQueue.shift()!;
      
      try {
        const result = await item.operation();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
        this.logger.error("Proxy operation failed", extractError(error));
      }
    }
    
    this.processingQueue = false;
    this.logger.debug("Finished processing proxy operation queue");
  }

  /**
   * Initialize the proxy manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.client.connect();
      this.initialized = true;
      this.logger.info("Proxy manager initialized");
    } catch (error) {
      this.logger.error("Failed to initialize proxy manager", extractError(error));
      throw error;
    }
  }

  /**
   * Close the proxy manager
   */
  async close(): Promise<void> {
    if (!this.initialized) return;

    try {
      await this.client.disconnect();
      this.initialized = false;
      this.logger.info("Proxy manager closed");
    } catch (error) {
      this.logger.error("Error closing proxy manager", extractError(error));
    }
  }

  /**
   * Create entities
   */
  async createEntities(entities: Entity[]): Promise<Entity[]> {
    // Use concurrency control for bulk write operations
    return this.executeWithConcurrencyControl(async () => {
      return await this.client.sendRequest({
        type: "create_entities",
        payload: { entities },
      });
    });
  }

  /**
   * Create relations
   */
  async createRelations(relations: Relation[]): Promise<Relation[]> {
    return await this.client.sendRequest({
      type: "create_relations",
      payload: { relations },
    });
  }

  /**
   * Add observations to entities
   */
  async addObservations(observations: Array<Observation>): Promise<Observation[]> {
    // Use concurrency control for bulk write operations
    return this.executeWithConcurrencyControl(async () => {
      return await this.client.sendRequest({
        type: "add_observations",
        payload: { observations },
      });
    });
  }

  /**
   * Delete entities
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    // Use concurrency control for deletion operations
    return this.executeWithConcurrencyControl(async () => {
      await this.client.sendRequest({
        type: "delete_entities",
        payload: { entityNames },
      });
    });
  }

  /**
   * Delete observations from entities
   */
  async deleteObservations(deletions: Array<Observation>): Promise<void> {
    await this.client.sendRequest({
      type: "delete_observations",
      payload: { deletions },
    });
  }

  /**
   * Delete relations
   */
  async deleteRelations(relations: Relation[]): Promise<void> {
    await this.client.sendRequest({
      type: "delete_relations",
      payload: { relations },
    });
  }

  /**
   * Search for entities
   */
  async searchNodes(query: string, options?: SearchNodesOptions): Promise<KnowledgeGraph> {
    return await this.client.sendRequest({
      type: "search_nodes",
      payload: { query, options },
    });
  }

  /**
   * Search for entities using multiple keywords
   */
  async searchMultiKeywords(
    keywords: string[],
    options?: MultiKeywordSearchOptions
  ): Promise<KnowledgeGraph> {
    return await this.client.sendRequest({
      type: "search_multi_keywords",
      payload: { keywords, options },
    });
  }

  /**
   * Get entities by name
   */
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    return await this.client.sendRequest({
      type: "open_nodes",
      payload: { names },
    });
  }

  /**
   * Read the entire knowledge graph
   */
  async readGraph(): Promise<KnowledgeGraph> {
    return await this.client.sendRequest({
      type: "read_graph",
      payload: {},
    });
  }

  /**
   * Rebuild FTS indexes for maintenance or after bulk data changes
   */
  async rebuildFTSIndexes(): Promise<void> {
    // Use concurrency control for FTS rebuild operations
    return this.executeWithConcurrencyControl(async () => {
      await this.client.sendRequest({
        type: "rebuild_fts_indexes",
        payload: {},
      });
    });
  }

  /**
   * Check FTS index health and status
   */
  async checkFTSIndexHealth(): Promise<{
    ftsEnabled: boolean;
    entitiesIndexed: number;
    observationsIndexed: number;
    status: string;
  }> {
    return await this.client.sendRequest({
      type: "check_fts_index_health",
      payload: {},
    });
  }

  /**
   * Get FTS configuration and statistics
   */
  async getFTSInfo(): Promise<{
    enabled: boolean;
    extensionLoaded: boolean;
    searchStrategy: string;
    indexCount: number;
  }> {
    return await this.client.sendRequest({
      type: "get_fts_info",
      payload: {},
    });
  }

  /**
   * Manual checkpoint to force WAL data to be written to disk
   */
  async checkpoint(): Promise<{ success: boolean; message: string }> {
    return await this.client.sendRequest({
      type: "checkpoint",
      payload: {},
    });
  }
}