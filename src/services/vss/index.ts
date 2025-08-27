// VSS (Vector Similarity Search) 服務入口檔案

// 匯出所有 VSS 相關類型
export type {
  IVSSManager,
  VSSConfig,
  VSSConfigType,
  VSSSearchOptions,
  VSSSearchResult,
  VSSHealthCheck,
  VSSStats,
  VSSIndexStatus,
} from '../../types/vss.js';

// 匯出錯誤類型和配置
export { 
  VSSError, 
  VSSConfigSchema, 
  VSSSearchOptionsSchema,
  DEFAULT_VSS_CONFIG 
} from '../../types/vss.js';

// 匯出服務實現
export { DuckDBVSSManager } from './vss-manager.js';

// 工具函數：建立 VSS 配置
export function createVSSConfig(overrides: Partial<VSSConfigType> = {}): VSSConfigType {
  return {
    enabled: overrides.enabled ?? true,
    indexParams: {
      metric: overrides.indexParams?.metric ?? 'cosine',
      efConstruction: overrides.indexParams?.efConstruction ?? 200,
      M: overrides.indexParams?.M ?? 16,
    },
    autoRebuild: {
      enabled: overrides.autoRebuild?.enabled ?? true,
      threshold: overrides.autoRebuild?.threshold ?? 0.1,
      batchSize: overrides.autoRebuild?.batchSize ?? 100,
    },
    fallback: {
      enabled: overrides.fallback?.enabled ?? true,
      fallbackToKeyword: overrides.fallback?.fallbackToKeyword ?? true,
      healthCheckInterval: overrides.fallback?.healthCheckInterval ?? 60000,
    },
  };
}

// 工具函數：驗證 VSS 配置
export function validateVSSConfig(config: any): VSSConfigType {
  return VSSConfigSchema.parse(config);
}

// 工具函數：檢查相似度閾值是否有效
export function isValidSimilarityThreshold(threshold: number): boolean {
  return threshold >= 0 && threshold <= 1;
}

// 工具函數：格式化相似度為百分比
export function formatSimilarity(similarity: number): string {
  return `${(similarity * 100).toFixed(1)}%`;
}

// 支援的相似度度量方法
export const SUPPORTED_METRICS = ['cosine', 'euclidean', 'dot_product'] as const;

// 預設搜尋選項
export const DEFAULT_SEARCH_OPTIONS: Required<VSSSearchOptions> = {
  threshold: 0.7,
  limit: 20,
  scope: undefined,
  timeRange: undefined,
  includeEmbeddings: false,
  searchTarget: 'both',
} as any;

// HNSW 索引建議參數
export const HNSW_PARAMETER_RECOMMENDATIONS = {
  small: {
    // < 10K 向量
    efConstruction: 100,
    M: 8,
  },
  medium: {
    // 10K - 100K 向量
    efConstruction: 200,
    M: 16,
  },
  large: {
    // > 100K 向量
    efConstruction: 400,
    M: 32,
  },
} as const;

// 工具函數：根據資料集大小推薦 HNSW 參數
export function recommendHNSWParameters(vectorCount: number): { efConstruction: number; M: number } {
  if (vectorCount < 10000) {
    return HNSW_PARAMETER_RECOMMENDATIONS.small;
  } else if (vectorCount < 100000) {
    return HNSW_PARAMETER_RECOMMENDATIONS.medium;
  } else {
    return HNSW_PARAMETER_RECOMMENDATIONS.large;
  }
}