import { z } from "zod";

// Embedding 向量類型
export type EmbeddingVector = number[];

// Embedding 結果接口
export interface EmbeddingResult {
  id: string;
  vector: EmbeddingVector;
  text: string;
  model: string;
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

// Embedding 批次結果
export interface BatchEmbeddingResult {
  embeddings: EmbeddingResult[];
  totalUsage: {
    promptTokens: number;
    totalTokens: number;
  };
}

// Embedding 服務配置 Schema
export const EmbeddingServiceConfigSchema = z.object({
  apiKey: z.string().describe("OpenAI API key"),
  model: z.string().default("text-embedding-3-small").describe("Embedding model to use"),
  timeout: z.number().default(30000).describe("Request timeout in milliseconds"),
  retries: z.number().default(3).describe("Number of retry attempts"),
  batchSize: z.number().default(100).describe("Maximum batch size for embeddings"),
  baseURL: z.string().optional().describe("Custom OpenAI API base URL"),
});

export type EmbeddingServiceConfig = z.infer<typeof EmbeddingServiceConfigSchema>;

// Embedding 快取統計
export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

// Embedding 服務介面
export interface IEmbeddingService {
  /**
   * 生成單個文本的 embedding
   */
  generateEmbedding(text: string): Promise<EmbeddingResult>;
  
  /**
   * 批量生成 embeddings
   */
  generateBatchEmbeddings(texts: string[]): Promise<BatchEmbeddingResult>;
  
  /**
   * 檢查服務健康狀態
   */
  checkHealth(): Promise<boolean>;
  
  /**
   * 獲取服務配置信息
   */
  getConfig(): EmbeddingServiceConfig;
}

// Embedding 快取介面
export interface IEmbeddingCache {
  /**
   * 獲取快取的 embedding
   */
  get(key: string): Promise<EmbeddingVector | null>;
  
  /**
   * 設置 embedding 快取
   */
  set(key: string, embedding: EmbeddingVector): Promise<void>;
  
  /**
   * 檢查是否存在快取
   */
  has(key: string): Promise<boolean>;
  
  /**
   * 清除所有快取
   */
  clear(): Promise<void>;
  
  /**
   * 獲取快取統計資訊
   */
  getStats(): Promise<EmbeddingCacheStats>;
}

// Embedding 錯誤類型
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

// 快取鍵生成函數
export function generateCacheKey(text: string, model: string): string {
  // 使用簡單的 hash 函數生成鍵值
  const textHash = Buffer.from(text).toString('base64').slice(0, 16);
  return `${model}:${textHash}`;
}