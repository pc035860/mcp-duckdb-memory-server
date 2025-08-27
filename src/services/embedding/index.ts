// Embedding 服務入口檔案

// 匯出所有類型
export type {
  IEmbeddingService,
  IEmbeddingCache,
  EmbeddingServiceConfig,
  EmbeddingResult,
  BatchEmbeddingResult,
  EmbeddingVector,
  EmbeddingCacheStats,
} from '../../types/embedding.js';

// 匯出錯誤類型和工具函數
export { 
  EmbeddingError, 
  generateCacheKey, 
  EmbeddingServiceConfigSchema 
} from '../../types/embedding.js';

// 匯出服務實現
export { OpenAIEmbeddingService } from './openai-embedding-service.js';

// 匯出快取實現
export { EmbeddingLRUCache, createEmbeddingCache } from './embedding-cache.js';

// 預設配置常量
export const DEFAULT_EMBEDDING_CONFIG = {
  model: 'text-embedding-3-small',
  timeout: 30000,
  retries: 3,
  batchSize: 100,
} as const;

// 支援的模型清單
export const SUPPORTED_MODELS = [
  'text-embedding-3-small',  // 1536 dimensions, $0.00002 / 1K tokens
  'text-embedding-3-large',  // 3072 dimensions, $0.00013 / 1K tokens  
  'text-embedding-ada-002',  // 1536 dimensions, $0.0001 / 1K tokens (legacy)
] as const;

// 模型維度對映
export const MODEL_DIMENSIONS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
} as const;

// 工具函數：獲取模型維度
export function getModelDimensions(model: string): number {
  return MODEL_DIMENSIONS[model as keyof typeof MODEL_DIMENSIONS] || 1536;
}

// 工具函數：驗證模型名稱
export function isSupportedModel(model: string): model is keyof typeof MODEL_DIMENSIONS {
  return model in MODEL_DIMENSIONS;
}