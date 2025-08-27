import { z } from "zod";
import type { EmbeddingVector } from "./embedding.js";
import type { Entity, Relation, TimeRangeOptions } from "../types.js";

// VSS 搜尋結果
export interface VSSSearchResult {
  entity: Entity;
  similarity: number;
  matchSource: 'entity' | 'observation';
  matchedContent?: string;
  embedding?: EmbeddingVector;
}

// VSS 搜尋選項
export interface VSSSearchOptions {
  /** 相似度閾值 (0-1) */
  threshold?: number;
  /** 最大返回結果數 */
  limit?: number;
  /** 搜尋範圍限制 */
  scope?: string;
  /** 時間範圍過濾 */
  timeRange?: TimeRangeOptions;
  /** 是否包含 embedding 向量 */
  includeEmbeddings?: boolean;
  /** 搜尋目標：僅實體、僅觀察或兩者 */
  searchTarget?: 'entities' | 'observations' | 'both';
}

// VSS 搜尋選項 Schema
export const VSSSearchOptionsSchema = z.object({
  threshold: z.number().min(0).max(1).optional().default(0.7),
  limit: z.number().int().positive().optional().default(20),
  scope: z.string().optional(),
  timeRange: z.object({
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    lastDays: z.number().int().positive().optional(),
    lastHours: z.number().int().positive().optional(),
    lastMinutes: z.number().int().positive().optional(),
  }).optional(),
  includeEmbeddings: z.boolean().optional().default(false),
  searchTarget: z.enum(['entities', 'observations', 'both']).optional().default('both'),
});

// VSS 索引狀態
export interface VSSIndexStatus {
  name: string;
  table: string;
  column: string;
  indexType: 'HNSW' | 'IVF';
  metric: 'cosine' | 'euclidean' | 'dot_product';
  dimensions: number;
  totalVectors: number;
  parameters: Record<string, any>;
  isHealthy: boolean;
  lastUpdated?: string;
}

// VSS 健康檢查結果
export interface VSSHealthCheck {
  vssExtensionLoaded: boolean;
  indexesHealthy: boolean;
  indexes: VSSIndexStatus[];
  embeddingService: boolean;
  cache: boolean;
  overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  issues: string[];
}

// VSS 統計資訊
export interface VSSStats {
  totalEntitiesWithEmbeddings: number;
  totalObservationsWithEmbeddings: number;
  embeddingCoverage: {
    entities: number; // 百分比
    observations: number; // 百分比
  };
  indexStats: VSSIndexStatus[];
  cacheStats: {
    hitRate: number;
    size: number;
    maxSize: number;
  };
  searchStats: {
    totalSearches: number;
    semanticSearches: number;
    hybridSearches: number;
    avgLatency: number;
  };
}

// VSS 配置
export interface VSSConfig {
  /** 是否啟用 VSS */
  enabled: boolean;
  /** HNSW 索引參數 */
  indexParams: {
    metric: 'cosine' | 'euclidean' | 'dot_product';
    efConstruction: number;
    M: number;
  };
  /** 自動重建索引參數 */
  autoRebuild: {
    enabled: boolean;
    threshold: number; // 未索引向量比例閾值
    batchSize: number;
  };
  /** 降級策略 */
  fallback: {
    enabled: boolean;
    fallbackToKeyword: boolean;
    healthCheckInterval: number; // 毫秒
  };
}

// VSS 配置 Schema
export const VSSConfigSchema = z.object({
  enabled: z.boolean().default(true),
  indexParams: z.object({
    metric: z.enum(['cosine', 'euclidean', 'dot_product']).default('cosine'),
    efConstruction: z.number().int().positive().default(200),
    M: z.number().int().positive().default(16),
  }).default({
    metric: 'cosine',
    efConstruction: 200,
    M: 16,
  }),
  autoRebuild: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().min(0).max(1).default(0.1),
    batchSize: z.number().int().positive().default(100),
  }).default({
    enabled: true,
    threshold: 0.1,
    batchSize: 100,
  }),
  fallback: z.object({
    enabled: z.boolean().default(true),
    fallbackToKeyword: z.boolean().default(true),
    healthCheckInterval: z.number().int().positive().default(60000),
  }).default({
    enabled: true,
    fallbackToKeyword: true,
    healthCheckInterval: 60000,
  }),
});

export type VSSConfigType = z.infer<typeof VSSConfigSchema>;

// VSS 管理器介面
export interface IVSSManager {
  /**
   * 初始化 VSS Extension 和索引
   */
  initialize(): Promise<void>;

  /**
   * 檢查 VSS 是否可用
   */
  isEnabled(): boolean;

  /**
   * 建立或更新 embedding 索引
   */
  createOrUpdateIndexes(): Promise<void>;

  /**
   * 使用向量搜尋查詢
   */
  searchWithVSS(queryEmbedding: EmbeddingVector, options?: VSSSearchOptions): Promise<VSSSearchResult[]>;

  /**
   * 為實體和觀察更新 embeddings
   */
  updateEntityEmbeddings(entityNames: string[]): Promise<void>;

  /**
   * 批量更新 embeddings
   */
  batchUpdateEmbeddings(entities: Entity[]): Promise<void>;

  /**
   * 檢查 VSS 健康狀態
   */
  checkHealth(): Promise<VSSHealthCheck>;

  /**
   * 獲取 VSS 統計資訊
   */
  getStats(): Promise<VSSStats>;

  /**
   * 重建所有索引
   */
  rebuildIndexes(): Promise<void>;

  /**
   * 清理無效的 embeddings
   */
  cleanupInvalidEmbeddings(): Promise<void>;
}

// VSS 錯誤類型
export class VSSError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean = false,
    public fallbackAvailable: boolean = true
  ) {
    super(message);
    this.name = 'VSSError';
  }
}

// 預設 VSS 配置
export const DEFAULT_VSS_CONFIG: VSSConfigType = {
  enabled: true,
  indexParams: {
    metric: 'cosine',
    efConstruction: 200,
    M: 16,
  },
  autoRebuild: {
    enabled: true,
    threshold: 0.1,
    batchSize: 100,
  },
  fallback: {
    enabled: true,
    fallbackToKeyword: true,
    healthCheckInterval: 60000,
  },
};