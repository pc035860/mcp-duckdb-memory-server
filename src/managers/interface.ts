import {
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  MultiKeywordSearchOptions,
} from "../types";

/**
 * Interface for knowledge graph management operations
 */
export interface KnowledgeGraphManagerInterface {
  /**
   * Create entities
   * @param entities Array of entities to create
   * @returns Array of created entities
   */
  createEntities(entities: Entity[]): Promise<Entity[]>;

  /**
   * Create relations
   * @param relations Array of relations to create
   * @returns Array of created relations
   */
  createRelations(relations: Relation[]): Promise<Relation[]>;

  /**
   * Add observations to entities
   * @param observations Array of observations to add
   * @returns Array of added observations
   */
  addObservations(observations: Array<Observation>): Promise<Observation[]>;

  /**
   * Delete entities
   * @param entityNames Array of entity names to delete
   */
  deleteEntities(entityNames: string[]): Promise<void>;

  /**
   * Delete observations from entities
   * @param deletions Array of observations to delete
   */
  deleteObservations(deletions: Array<Observation>): Promise<void>;

  /**
   * Delete relations
   * @param relations Array of relations to delete
   */
  deleteRelations(relations: Relation[]): Promise<void>;

  /**
   * Search for entities
   * @param query Search query
   * @returns Knowledge graph with matching entities and their relations
   */
  searchNodes(query: string): Promise<KnowledgeGraph>;

  /**
   * Search for entities using multiple keywords
   * @param keywords Array of keywords to search
   * @param options Search options
   * @returns Knowledge graph with matching entities and their relations
   */
  searchMultiKeywords(
    keywords: string[],
    options?: MultiKeywordSearchOptions
  ): Promise<KnowledgeGraph>;

  /**
   * Get entities by name
   * @param names Array of entity names
   * @returns Knowledge graph with matching entities and their relations
   */
  openNodes(names: string[]): Promise<KnowledgeGraph>;

  /**
   * Initialize the manager
   */
  initialize(): Promise<void>;

  /**
   * Close and cleanup resources
   */
  close(): Promise<void>;
}