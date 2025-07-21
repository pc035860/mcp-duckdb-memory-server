import {
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  MultiKeywordSearchOptions,
} from "../../types";

/**
 * IPC Request types for all knowledge graph operations
 */
export type IPCRequest =
  | CreateEntitiesRequest
  | CreateRelationsRequest
  | AddObservationsRequest
  | DeleteEntitiesRequest
  | DeleteObservationsRequest
  | DeleteRelationsRequest
  | SearchNodesRequest
  | SearchMultiKeywordsRequest
  | OpenNodesRequest;

/**
 * IPC Response type
 */
export interface IPCResponse<T = any> {
  id: string;
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Base request interface
 */
interface BaseRequest {
  id: string;
  type: string;
}

/**
 * Create entities request
 */
export interface CreateEntitiesRequest extends BaseRequest {
  type: "create_entities";
  payload: {
    entities: Entity[];
  };
}

/**
 * Create relations request
 */
export interface CreateRelationsRequest extends BaseRequest {
  type: "create_relations";
  payload: {
    relations: Relation[];
  };
}

/**
 * Add observations request
 */
export interface AddObservationsRequest extends BaseRequest {
  type: "add_observations";
  payload: {
    observations: Observation[];
  };
}

/**
 * Delete entities request
 */
export interface DeleteEntitiesRequest extends BaseRequest {
  type: "delete_entities";
  payload: {
    entityNames: string[];
  };
}

/**
 * Delete observations request
 */
export interface DeleteObservationsRequest extends BaseRequest {
  type: "delete_observations";
  payload: {
    deletions: Observation[];
  };
}

/**
 * Delete relations request
 */
export interface DeleteRelationsRequest extends BaseRequest {
  type: "delete_relations";
  payload: {
    relations: Relation[];
  };
}

/**
 * Search nodes request
 */
export interface SearchNodesRequest extends BaseRequest {
  type: "search_nodes";
  payload: {
    query: string;
  };
}

/**
 * Search multi keywords request
 */
export interface SearchMultiKeywordsRequest extends BaseRequest {
  type: "search_multi_keywords";
  payload: {
    keywords: string[];
    options?: MultiKeywordSearchOptions;
  };
}

/**
 * Open nodes request
 */
export interface OpenNodesRequest extends BaseRequest {
  type: "open_nodes";
  payload: {
    names: string[];
  };
}

/**
 * Type guards for request types
 */
export function isCreateEntitiesRequest(req: IPCRequest): req is CreateEntitiesRequest {
  return req.type === "create_entities";
}

export function isCreateRelationsRequest(req: IPCRequest): req is CreateRelationsRequest {
  return req.type === "create_relations";
}

export function isAddObservationsRequest(req: IPCRequest): req is AddObservationsRequest {
  return req.type === "add_observations";
}

export function isDeleteEntitiesRequest(req: IPCRequest): req is DeleteEntitiesRequest {
  return req.type === "delete_entities";
}

export function isDeleteObservationsRequest(req: IPCRequest): req is DeleteObservationsRequest {
  return req.type === "delete_observations";
}

export function isDeleteRelationsRequest(req: IPCRequest): req is DeleteRelationsRequest {
  return req.type === "delete_relations";
}

export function isSearchNodesRequest(req: IPCRequest): req is SearchNodesRequest {
  return req.type === "search_nodes";
}

export function isSearchMultiKeywordsRequest(req: IPCRequest): req is SearchMultiKeywordsRequest {
  return req.type === "search_multi_keywords";
}

export function isOpenNodesRequest(req: IPCRequest): req is OpenNodesRequest {
  return req.type === "open_nodes";
}

/**
 * Utility function to generate request ID
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}