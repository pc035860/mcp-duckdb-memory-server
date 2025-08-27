import {
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  MultiKeywordSearchOptions,
  SearchNodesOptions,
  TimeRangeOptions,
  OpenNodesOptions,
} from "../../types";
import { validateTimeRangeOptions } from "../../utils/time-validation";

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
  | OpenNodesRequest
  | ReadGraphRequest
  | CheckpointRequest
  | RebuildFTSIndexesRequest
  | CheckFTSIndexHealthRequest
  | GetFTSInfoRequest;

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
    options?: SearchNodesOptions;
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
    options?: OpenNodesOptions;
  };
}

/**
 * Read graph request
 */
export interface ReadGraphRequest extends BaseRequest {
  type: "read_graph";
  payload: {};
}

/**
 * Checkpoint request
 */
export interface CheckpointRequest extends BaseRequest {
  type: "checkpoint";
  payload: {};
}

/**
 * Rebuild FTS indexes request
 */
export interface RebuildFTSIndexesRequest extends BaseRequest {
  type: "rebuild_fts_indexes";
  payload: {};
}

/**
 * Check FTS index health request
 */
export interface CheckFTSIndexHealthRequest extends BaseRequest {
  type: "check_fts_index_health";
  payload: {};
}

/**
 * Get FTS info request
 */
export interface GetFTSInfoRequest extends BaseRequest {
  type: "get_fts_info";
  payload: {};
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

export function isReadGraphRequest(req: IPCRequest): req is ReadGraphRequest {
  return req.type === "read_graph";
}

export function isCheckpointRequest(req: IPCRequest): req is CheckpointRequest {
  return req.type === "checkpoint";
}

export function isRebuildFTSIndexesRequest(req: IPCRequest): req is RebuildFTSIndexesRequest {
  return req.type === "rebuild_fts_indexes";
}

export function isCheckFTSIndexHealthRequest(req: IPCRequest): req is CheckFTSIndexHealthRequest {
  return req.type === "check_fts_index_health";
}

export function isGetFTSInfoRequest(req: IPCRequest): req is GetFTSInfoRequest {
  return req.type === "get_fts_info";
}

/**
 * Utility function to generate request ID
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Validates time range options in IPC requests
 * Throws an error if validation fails
 */
export function validateRequestTimeRange(timeRange?: TimeRangeOptions): void {
  if (!timeRange) {
    return;
  }

  const validation = validateTimeRangeOptions(timeRange);
  if (!validation.valid) {
    throw new Error(`Invalid time range options: ${validation.errors.join('; ')}`);
  }
}

/**
 * Validates search nodes request payload
 */
export function validateSearchNodesRequest(payload: SearchNodesRequest['payload']): void {
  if (!payload.query || typeof payload.query !== 'string') {
    throw new Error('Search query is required and must be a string');
  }

  if (payload.options?.timeRange) {
    validateRequestTimeRange(payload.options.timeRange);
  }
}

/**
 * Validates search multi keywords request payload  
 */
export function validateSearchMultiKeywordsRequest(payload: SearchMultiKeywordsRequest['payload']): void {
  if (!Array.isArray(payload.keywords) || payload.keywords.length === 0) {
    throw new Error('Keywords array is required and cannot be empty');
  }

  if (payload.keywords.some(keyword => typeof keyword !== 'string')) {
    throw new Error('All keywords must be strings');
  }

  if (payload.options?.timeRange) {
    validateRequestTimeRange(payload.options.timeRange);
  }
}