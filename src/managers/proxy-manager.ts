import {
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  MultiKeywordSearchOptions,
} from "../types";
import { KnowledgeGraphManagerInterface } from "./interface";
import { IPCSocketClient } from "../servers/ipc/socket-client";
import { Logger } from "../logger";

/**
 * Proxy manager that forwards requests to main server via IPC
 */
export class ProxyKnowledgeGraphManager implements KnowledgeGraphManagerInterface {
  private client: IPCSocketClient;
  private logger: Logger;
  private initialized: boolean = false;

  constructor(socketPath: string, logger: Logger) {
    this.client = new IPCSocketClient(socketPath, logger);
    this.logger = logger;
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
      this.logger.error("Failed to initialize proxy manager", error);
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
      this.logger.error("Error closing proxy manager", error);
    }
  }

  /**
   * Create entities
   */
  async createEntities(entities: Entity[]): Promise<Entity[]> {
    return await this.client.sendRequest({
      type: "create_entities",
      payload: { entities },
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
    return await this.client.sendRequest({
      type: "add_observations",
      payload: { observations },
    });
  }

  /**
   * Delete entities
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    await this.client.sendRequest({
      type: "delete_entities",
      payload: { entityNames },
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
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    return await this.client.sendRequest({
      type: "search_nodes",
      payload: { query },
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
   * Manual checkpoint to force WAL data to be written to disk
   */
  async checkpoint(): Promise<{ success: boolean; message: string }> {
    return await this.client.sendRequest({
      type: "checkpoint",
      payload: {},
    });
  }
}