import OpenAI from 'openai';
import type { 
  IEmbeddingService, 
  EmbeddingServiceConfig, 
  EmbeddingResult, 
  BatchEmbeddingResult
} from '../../types/embedding.js';
import { EmbeddingError } from '../../types/embedding.js';
import { logger } from '../../logger.js';

export class OpenAIEmbeddingService implements IEmbeddingService {
  private client: OpenAI;
  private config: EmbeddingServiceConfig;

  constructor(config: EmbeddingServiceConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout,
      maxRetries: config.retries,
    });
    
    logger.info('OpenAI Embedding Service initialized', { 
      model: config.model,
      timeout: config.timeout,
      retries: config.retries,
      batchSize: config.batchSize
    });
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    try {
      logger.debug('Generating embedding for text', { 
        textLength: text.length,
        model: this.config.model 
      });

      const response = await this.client.embeddings.create({
        model: this.config.model,
        input: text,
        encoding_format: 'float',
      });

      const embedding = response.data[0];
      const usage = response.usage;

      const result: EmbeddingResult = {
        id: `embedding_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        vector: embedding.embedding,
        text,
        model: this.config.model,
        usage: {
          promptTokens: usage.prompt_tokens,
          totalTokens: usage.total_tokens,
        },
      };

      logger.debug('Embedding generated successfully', {
        id: result.id,
        vectorDimension: result.vector.length,
        usage: result.usage
      });

      return result;
    } catch (error) {
      const embeddingError = this.handleError(error, 'generateEmbedding');
      logger.error('Failed to generate embedding', {
        textLength: text.length,
        model: this.config.model,
        error: embeddingError.message,
        code: embeddingError.code,
        retryable: embeddingError.retryable
      });
      throw embeddingError;
    }
  }

  async generateBatchEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
    if (texts.length === 0) {
      return {
        embeddings: [],
        totalUsage: { promptTokens: 0, totalTokens: 0 }
      };
    }

    // 如果超過批次大小，分批處理
    if (texts.length > this.config.batchSize) {
      return await this.processBatchesRecursively(texts);
    }

    try {
      logger.debug('Generating batch embeddings', { 
        batchSize: texts.length,
        model: this.config.model 
      });

      const response = await this.client.embeddings.create({
        model: this.config.model,
        input: texts,
        encoding_format: 'float',
      });

      const embeddings: EmbeddingResult[] = response.data.map((embedding, index) => ({
        id: `embedding_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        vector: embedding.embedding,
        text: texts[index],
        model: this.config.model,
      }));

      const totalUsage = {
        promptTokens: response.usage.prompt_tokens,
        totalTokens: response.usage.total_tokens,
      };

      logger.debug('Batch embeddings generated successfully', {
        count: embeddings.length,
        usage: totalUsage
      });

      return {
        embeddings,
        totalUsage,
      };
    } catch (error) {
      const embeddingError = this.handleError(error, 'generateBatchEmbeddings');
      logger.error('Failed to generate batch embeddings', {
        batchSize: texts.length,
        model: this.config.model,
        error: embeddingError.message,
        code: embeddingError.code,
        retryable: embeddingError.retryable
      });
      throw embeddingError;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      // 使用一個簡單的文本測試服務健康狀態
      const testText = 'health check';
      await this.generateEmbedding(testText);
      
      logger.debug('Embedding service health check passed');
      return true;
    } catch (error) {
      logger.error('Embedding service health check failed', { error });
      return false;
    }
  }

  getConfig(): EmbeddingServiceConfig {
    return { ...this.config };
  }

  private async processBatchesRecursively(texts: string[]): Promise<BatchEmbeddingResult> {
    const allEmbeddings: EmbeddingResult[] = [];
    let totalPromptTokens = 0;
    let totalTokens = 0;

    // 分批處理
    for (let i = 0; i < texts.length; i += this.config.batchSize) {
      const batch = texts.slice(i, i + this.config.batchSize);
      const batchResult = await this.generateBatchEmbeddings(batch);
      
      allEmbeddings.push(...batchResult.embeddings);
      totalPromptTokens += batchResult.totalUsage.promptTokens;
      totalTokens += batchResult.totalUsage.totalTokens;

      // 添加小延遲以避免率限制
      if (i + this.config.batchSize < texts.length) {
        await this.sleep(100); // 100ms 延遲
      }
    }

    return {
      embeddings: allEmbeddings,
      totalUsage: {
        promptTokens: totalPromptTokens,
        totalTokens,
      },
    };
  }

  private handleError(error: unknown, operation: string): EmbeddingError {
    if (error instanceof OpenAI.APIError) {
      const isRetryable = error.status === 429 || error.status >= 500;
      
      return new EmbeddingError(
        `OpenAI API error in ${operation}: ${error.message}`,
        error.code || 'OPENAI_API_ERROR',
        error.status,
        isRetryable
      );
    }

    if (error instanceof Error) {
      return new EmbeddingError(
        `Error in ${operation}: ${error.message}`,
        'UNKNOWN_ERROR',
        undefined,
        false
      );
    }

    return new EmbeddingError(
      `Unknown error in ${operation}`,
      'UNKNOWN_ERROR',
      undefined,
      false
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}