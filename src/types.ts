import { z } from "zod";
import { DuckDBValue } from '@duckdb/node-api';

/**
 * Database row type for DuckDB query results
 * Represents a single row returned by DuckDB queries
 */
export type DatabaseRow = DuckDBValue[];

/**
 * The primary nodes in the knowledge graph
 */
export const EntityObject = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z
    .array(z.string())
    .describe("An array of observation contents associated with the entity"),
  createdAt: z.string().describe("ISO 8601 timestamp when the entity was created"),
});
export type Entity = z.infer<typeof EntityObject> & {
  // Optional summary fields for compact output
  observationsCount?: number;
  observationsPreview?: string[];
  omittedObservations?: number;
};

/**
 * Relations define directed connections between entities.
 *
 * They are always stored in active voice and describe how entities interact or relate to each other
 */
export const RelationObject = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});
export type Relation = {
  from: string;
  to: string;
  relationType: string;
  createdAt?: string; // ISO 8601 timestamp, optional for backward compatibility
};

/**
 * Observations are discrete pieces of information about an entity
 */
export const ObservationObject = z.object({
  entityName: z
    .string()
    .describe("The name of the entity to add the observations to"),
  contents: z
    .array(z.string())
    .describe("An array of observation contents to add"),
});
export type Observation = z.infer<typeof ObservationObject> & {
  createdAt?: string; // ISO 8601 timestamp, optional for backward compatibility
};

/**
 * The knowledge graph is the primary data structure for storing information in the system
 */
export type KnowledgeGraph = {
  entities: Entity[];
  relations: Relation[];
  // Optional metadata for compact/truncated responses
  omittedEntities?: number;
  omittedRelations?: number;
  truncated?: boolean;
};

/**
 * Time range options for search operations
 */
export type TimeRangeOptions = {
  // Absolute time range
  createdAfter?: string;   // ISO 8601 format: '2024-01-01T00:00:00Z'
  createdBefore?: string;  // ISO 8601 format: '2024-12-31T23:59:59Z'
  
  // Relative time range
  lastDays?: number;       // Last N days
  lastHours?: number;      // Last N hours
  lastMinutes?: number;    // Last N minutes
  
  // Time range application target
  timeScope?: 'entities' | 'observations' | 'relations' | 'any';
};

/**
 * Output limiting options for controlling response size
 */
export type OutputLimitOptions = {
  compact?: boolean; // If true, prefer minimal payload
  includeObservations?: boolean; // If false, omit observations contents
  maxEntities?: number;
  maxObservationsPerEntity?: number;
  snippetChars?: number;
  includeRelations?: 'none' | 'subset' | 'all';
  maxRelations?: number;
  maxResponseChars?: number;
};

/**
 * Options for multi-keyword search
 */
export type MultiKeywordSearchOptions = {
  mode?: 'OR' | 'AND';  // How to combine keywords, defaults to 'OR'
  scope?: string;  // Optional scope to filter entities, e.g., "project" or "[project]"
  timeRange?: TimeRangeOptions;  // Optional time range filtering
  output?: OutputLimitOptions; // Optional output limiting options
};

/**
 * Options for searchNodes method
 */
export type SearchNodesOptions = {
  scope?: string;  // Optional scope to filter entities, e.g., "project" or "[project]"
  timeRange?: TimeRangeOptions;  // Optional time range filtering
  output?: OutputLimitOptions; // Optional output limiting options
};

/**
 * Options for opening nodes
 */
export type OpenNodesOptions = {
  includeObservations?: boolean; // Default: true, for backward compatibility
};

/**
 * The KnowledgeGraphManagerInterface is the primary interface for interacting with the knowledge graph
 */
export type KnowledgeGraphManagerInterface = {
  createEntities(entities: Entity[]): Promise<Entity[]>;
  createRelations(relations: Relation[]): Promise<Relation[]>;
  addObservations(observations: Array<Observation>): Promise<Observation[]>;
  deleteEntities(entityNames: string[]): Promise<void>;
  deleteObservations(deletions: Array<Observation>): Promise<void>;
  deleteRelations(relations: Relation[]): Promise<void>;
  searchNodes(query: string, options?: SearchNodesOptions): Promise<KnowledgeGraph>;
  searchMultiKeywords(keywords: string[], options?: MultiKeywordSearchOptions): Promise<KnowledgeGraph>;
  openNodes(names: string[], options?: OpenNodesOptions): Promise<KnowledgeGraph>;
};
