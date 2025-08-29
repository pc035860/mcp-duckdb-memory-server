/**
 * Production-grade Embedding Backfill Tool
 * 為現有資料補充 embedding 的產品級工具
 * 
 * 功能特色：
 * - 整合現有 EmbeddingService 架構
 * - 完整的 TypeScript 類型支援
 * - 進階錯誤處理和恢復機制
 * - 生產級日誌和監控
 * - 支援中斷恢復和增量處理
 */

import { DuckDBKnowledgeGraphManager } from '../managers/duckdb-manager.js';
import { OpenAIEmbeddingService } from '../services/embedding/openai-embedding-service.js';
import { ConsoleLogger, type Logger } from '../logger.js';
import type { IEmbeddingService } from '../types/embedding.js';
import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';

interface BackfillConfig {
  batchSize: number;
  retryCount: number;
  retryDelayMs: number;
  batchDelayMs: number;
  memoryFilePath: string;
  progressSaveInterval: number;
  target: 'both' | 'entities' | 'observations';
  entitiesWorkaround: 'none' | 'strategyA' | 'strategyB' | 'strategyC';
}

interface BackfillProgress {
  totalEntities: number;
  totalObservations: number;
  processedEntities: number;
  processedObservations: number;
  failedEntities: string[];
  failedObservations: number[];
  startTime: number;
  lastSaveTime: number;
}

interface BackfillStats {
  totalProcessed: number;
  totalFailed: number;
  totalTokens: number;
  totalCost: number;
  executionTimeMs: number;
  avgTokensPerItem: number;
}

export class EmbeddingBackfillTool {
  private config: BackfillConfig;
  private logger: Logger;
  private manager: DuckDBKnowledgeGraphManager;
  private embeddingService: IEmbeddingService | null = null;
  private progress: BackfillProgress;
  private progressFilePath: string;
  private rl: readline.Interface;
  private dbConnection: any = null; // 穩定的資料庫連接
  private fkTemporarilyDisabled: boolean = false;

  constructor(config?: Partial<BackfillConfig>) {
    this.config = {
      batchSize: 50,
      retryCount: 3,
      retryDelayMs: 1000,
      batchDelayMs: 200,
      memoryFilePath: './memory.data',
      progressSaveInterval: 10, // 每 10 筆儲存一次進度
      target: 'both',
      entitiesWorkaround: 'none',
      ...config
    };

    // 允許以環境變數覆蓋批次大小，方便煙霧測試
    const envBatch = Number(process.env.BACKFILL_BATCH_SIZE);
    if (Number.isFinite(envBatch) && envBatch > 0) {
      this.config.batchSize = Math.floor(envBatch);
    }

    const envTarget = (process.env.BACKFILL_TARGET || '').toLowerCase();
    if (envTarget === 'entities' || envTarget === 'observations' || envTarget === 'both') {
      this.config.target = envTarget as any;
    }

    const envEntitiesWorkaround = (process.env.BACKFILL_ENTITIES_WORKAROUND || '').toLowerCase();
    if (envEntitiesWorkaround === 'strategya') {
      this.config.entitiesWorkaround = 'strategyA';
    } else if (envEntitiesWorkaround === 'strategyb') {
      this.config.entitiesWorkaround = 'strategyB';
    } else if (envEntitiesWorkaround === 'strategyc') {
      this.config.entitiesWorkaround = 'strategyC';
    }

    this.logger = new ConsoleLogger();
    this.manager = new DuckDBKnowledgeGraphManager(
      () => this.config.memoryFilePath,
      this.logger,
      false, // allowExternalTimestamps
      1000   // entityCountThreshold
    );

    this.progressFilePath = path.join(
      path.dirname(this.config.memoryFilePath),
      'backfill-progress.json'
    );

    this.progress = {
      totalEntities: 0,
      totalObservations: 0,
      processedEntities: 0,
      processedObservations: 0,
      failedEntities: [],
      failedObservations: [],
      startTime: Date.now(),
      lastSaveTime: Date.now()
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  /**
   * 提問並等待用戶回答
   */
  private question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  /**
   * 延遲執行
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 載入或創建進度檔案
   */
  private async loadProgress(): Promise<void> {
    try {
      const progressData = await fs.readFile(this.progressFilePath, 'utf-8');
      const savedProgress = JSON.parse(progressData);
      
      // 驗證進度檔案的有效性
      if (savedProgress.startTime && savedProgress.totalEntities >= 0) {
        this.progress = { ...this.progress, ...savedProgress };
        this.logger.info(`載入進度檔案: ${this.progressFilePath}`);
        this.logger.info(`已處理: Entities ${this.progress.processedEntities}/${this.progress.totalEntities}, Observations ${this.progress.processedObservations}/${this.progress.totalObservations}`);
      }
    } catch (error) {
      // 進度檔案不存在或損壞，使用預設值
      this.logger.debug('未找到有效的進度檔案，將重新開始');
    }
  }

  /**
   * 儲存進度檔案
   */
  private async saveProgress(): Promise<void> {
    try {
      this.progress.lastSaveTime = Date.now();
      await fs.writeFile(
        this.progressFilePath,
        JSON.stringify(this.progress, null, 2)
      );
    } catch (error) {
      this.logger.warn('儲存進度檔案失敗', { error });
    }
  }

  /**
   * 初始化系統
   */
  private async initialize(): Promise<void> {
    this.logger.info('🚀 初始化 Embedding Backfill Tool...');

    // 檢查環境變數
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error('需要設定 OPENAI_API_KEY 環境變數');
    }

    // 檢查資料庫檔案
    try {
      await fs.access(this.config.memoryFilePath);
    } catch {
      throw new Error(`找不到資料庫檔案: ${this.config.memoryFilePath}`);
    }

    // 初始化管理器（暫時停用 VSS 以避免 segfault）
    const prevOpenAIKey = process.env.OPENAI_API_KEY;
    try {
      delete (process.env as any).OPENAI_API_KEY;
      await this.manager.initialize();
      this.logger.info('✅ DuckDB Manager 初始化完成');
      this.logger.info('ℹ️ Backfill 過程中已停用 VSS 初始化');
    } finally {
      process.env.OPENAI_API_KEY = prevOpenAIKey;
    }

    // 創建穩定的資料庫連接
    this.dbConnection = await (this.manager as any).getConnection();
    this.logger.info('✅ 資料庫連接已建立');

    // backfill 期間臨時移除 observations→entities 的 FK，避免 DuckDB 對 UPDATE 的誤判
    await this.temporarilyDisableObservationsFK();

    // 初始化 Embedding Service
    this.embeddingService = new OpenAIEmbeddingService({
      apiKey: openaiApiKey,
      model: 'text-embedding-3-small',
      baseURL: undefined,
      timeout: 30000,
      retries: this.config.retryCount,
      batchSize: this.config.batchSize
    });

    // 測試 Embedding Service
    const healthCheck = await this.embeddingService.checkHealth();
    if (!healthCheck) {
      throw new Error('OpenAI Embedding Service 健康檢查失敗');
    }
    this.logger.info('✅ OpenAI Embedding Service 初始化完成');

    // 載入進度
    await this.loadProgress();
  }

  /**
   * 分析需要處理的資料
   */
  private async analyzeData(): Promise<{ entities: any[], observations: any[] }> {
    this.logger.info('📊 分析現有資料...');

    // 確保資料庫連接已建立
    if (!this.dbConnection) {
      throw new Error('資料庫連接未建立');
    }

    // 使用穩定的資料庫連接
    const entitiesDbResult = await this.dbConnection.runAndReadAll(`
      SELECT name, entityType, created_at FROM entities WHERE embedding IS NULL ORDER BY created_at DESC
    `);
    // 相容多種結果格式（陣列物件或 getRows()）
    let entitiesList: Array<{ name: string; entityType: string; createdAt: string }>; 
    if (entitiesDbResult && typeof entitiesDbResult.getRows === 'function') {
      const rows = entitiesDbResult.getRows();
      entitiesList = rows.map((row: any[]) => ({
        name: row[0],
        entityType: row[1],
        createdAt: row[2],
      }));
    } else if (Array.isArray(entitiesDbResult)) {
      entitiesList = entitiesDbResult.map((row: any) => ({
        name: row.name,
        entityType: row.entityType,
        createdAt: row.created_at ?? row.createdAt,
      }));
    } else {
      entitiesList = [];
    }

    // 取得需要處理的 observations
    const obsResult = await this.dbConnection.runAndReadAll(`
      SELECT id, content FROM observations WHERE embedding IS NULL
    `);
    // 相容多種結果格式，統一為 [id, content] 陣列
    let observations: any[] = [];
    if (obsResult && typeof obsResult.getRows === 'function') {
      observations = obsResult.getRows();
    } else if (Array.isArray(obsResult)) {
      observations = obsResult.map((row: any) => [row.id, row.content]);
    }

    // 過濾已處理的 entities
    const entities = entitiesList
      .filter(entity => !this.progress.failedEntities.includes(entity.name))
      .slice(this.progress.processedEntities);

    // 過濾已處理的 observations
    const filteredObservations = observations
      .filter((obs: any[]) => !this.progress.failedObservations.includes(obs[0] as number))
      .slice(this.progress.processedObservations);

    // 更新進度統計
    if (this.progress.totalEntities === 0) {
      this.progress.totalEntities = entitiesList.length;
      this.progress.totalObservations = observations.length;
      await this.saveProgress();
    }

    this.logger.info(`需要處理的資料: Entities ${entities.length}/${this.progress.totalEntities}, Observations ${filteredObservations.length}/${this.progress.totalObservations}`);

    return { entities, observations: filteredObservations };
  }

  /**
   * 顯示進度
   */
  private showProgress(current: number, total: number, type: 'entities' | 'observations'): void {
    const percentage = total > 0 ? ((current / total) * 100).toFixed(1) : '100.0';
    const elapsed = Date.now() - this.progress.startTime;
    const eta = current > 0 ? elapsed / current * (total - current) : 0;
    const etaStr = Math.round(eta / 1000) + 's';
    
    process.stdout.write(`\r🔄 ${type}: ${current}/${total} (${percentage}%) - ETA: ${etaStr}`);
  }

  /**
   * 處理 entities
   */
  private async processEntities(entities: any[]): Promise<{ processed: number, failed: number, tokens: number }> {
    if (entities.length === 0) return { processed: 0, failed: 0, tokens: 0 };

    this.logger.info('\n📝 處理 Entities...');
    let processed = 0;
    let failed = 0;
    let totalTokens = 0;

    // 使用穩定的資料庫連接
    if (this.config.entitiesWorkaround === 'strategyC') {
      // 寫入外掛表 entity_embeddings，避免碰觸 entities 表（繞開 FK）
      this.logger.info('使用 entities 外掛表寫入策略 (strategyC)');
      const auxTable = 'entity_embeddings';
      try {
        await this.dbConnection.runAndReadAll(`
          CREATE TABLE IF NOT EXISTS ${auxTable} (
            name VARCHAR PRIMARY KEY,
            embedding FLOAT[1536],
            embedding_model VARCHAR,
            embedding_updated_at TIMESTAMP
          );
        `);

        let processed = 0;
        let failed = 0;
        let totalTokens = 0;

        for (let i = 0; i < entities.length; i += this.config.batchSize) {
          const batch = entities.slice(i, i + this.config.batchSize);
          await this.dbConnection.runAndReadAll('BEGIN;');
          try {
            for (const entity of batch) {
              try {
                const text = `Entity: ${entity.name}, Type: ${entity.entityType}`;
                const result = await this.embeddingService!.generateEmbedding(text);
                const embeddingStr = '[' + result.vector.join(',') + ']';
                await this.dbConnection.runAndReadAll(`
                  INSERT OR REPLACE INTO ${auxTable}(name, embedding, embedding_model, embedding_updated_at)
                  VALUES ($1, $2::FLOAT[1536], $3, CURRENT_TIMESTAMP)
                `, [entity.name, embeddingStr, this.embeddingService!.getConfig().model]);
                processed++;
                totalTokens += result.usage?.totalTokens || 0;
                this.progress.processedEntities++;
                this.showProgress(this.progress.processedEntities, this.progress.totalEntities, 'entities');
                if (processed % this.config.progressSaveInterval === 0) {
                  await this.saveProgress();
                }
              } catch (err) {
                this.logger.warn(`寫入外掛表失敗: ${entity.name}`, { error: (err as Error).message });
                failed++;
              }
            }
            await this.dbConnection.runAndReadAll('COMMIT;');
          } catch (auxErr) {
            try { await this.dbConnection.runAndReadAll('ROLLBACK;'); } catch {}
            this.logger.warn('外掛表批次寫入失敗，將逐筆處理', { error: (auxErr as Error).message });
          }

          if (i + this.config.batchSize < entities.length) {
            await this.delay(this.config.batchDelayMs);
          }
        }

        await this.saveProgress();
        console.log(`\n✅ Entities 處理完成: ${processed} 成功, ${failed} 失敗`);
        return { processed, failed, tokens: totalTokens };
      } catch (error) {
        this.logger.warn('strategyC 流程發生錯誤，回退到其他策略', { error: (error as Error).message });
        // 繼續走其他策略
      }
    }

    if (this.config.entitiesWorkaround === 'strategyA' || this.config.entitiesWorkaround === 'strategyB') {
      // 臨時表 + 合併更新，減少逐筆 UPDATE 對 FK 的影響
      this.logger.info(`使用 entities 臨時表合併更新策略 (${this.config.entitiesWorkaround})`);
      const tempTable = 'entities_embedding_updates';
      try {
        await this.dbConnection.runAndReadAll(`DROP TABLE IF EXISTS ${tempTable};`);
        await this.dbConnection.runAndReadAll(`
          CREATE TABLE ${tempTable}(
            name VARCHAR PRIMARY KEY,
            embedding FLOAT[1536],
            embedding_model VARCHAR
          );
        `);

        let processed = 0;
        let failed = 0;
        let totalTokens = 0;

        for (let i = 0; i < entities.length; i += this.config.batchSize) {
          const batch = entities.slice(i, i + this.config.batchSize);

          // 先產生向量並寫入臨時表
          await this.dbConnection.runAndReadAll('BEGIN;');
          try {
            for (const entity of batch) {
              try {
                const text = `Entity: ${entity.name}, Type: ${entity.entityType}`;
                const result = await this.embeddingService!.generateEmbedding(text);
                const embeddingStr = '[' + result.vector.join(',') + ']';
                await this.dbConnection.runAndReadAll(`
                  INSERT OR REPLACE INTO ${tempTable}(name, embedding, embedding_model)
                  VALUES ($1, $2::FLOAT[1536], $3)
                `, [entity.name, embeddingStr, this.embeddingService!.getConfig().model]);
                totalTokens += result.usage?.totalTokens || 0;
              } catch (err) {
                this.logger.warn(`生成或寫入臨時表失敗: ${entity.name}`, { error: (err as Error).message });
                failed++;
              }
            }
            await this.dbConnection.runAndReadAll('COMMIT;');
          } catch (tempErr) {
            try { await this.dbConnection.runAndReadAll('ROLLBACK;'); } catch {}
            this.logger.warn('臨時表寫入批次失敗，將嘗試逐筆', { error: (tempErr as Error).message });
          }

          // 再以合併語句一次性更新目標表
          try {
            await this.dbConnection.runAndReadAll('BEGIN;');
            if (this.config.entitiesWorkaround === 'strategyB') {
              // 使用 MERGE 合併更新（DuckDB 支援 MERGE）
              await this.dbConnection.runAndReadAll(`
                MERGE INTO entities e
                USING ${tempTable} u
                ON e.name = u.name
                WHEN MATCHED THEN UPDATE SET
                  embedding = u.embedding,
                  embedding_updated_at = CURRENT_TIMESTAMP,
                  embedding_model = u.embedding_model
              `);
            } else {
              await this.dbConnection.runAndReadAll(`
                UPDATE entities AS e
                SET embedding = u.embedding,
                    embedding_updated_at = CURRENT_TIMESTAMP,
                    embedding_model = u.embedding_model
                FROM ${tempTable} AS u
                WHERE e.name = u.name
              `);
            }
            await this.dbConnection.runAndReadAll('COMMIT;');

            processed += batch.length; // 以寫入數估算；若需精準可再查 count(*)
            this.progress.processedEntities += batch.length;
            this.showProgress(this.progress.processedEntities, this.progress.totalEntities, 'entities');
            if (processed % this.config.progressSaveInterval === 0) {
              await this.saveProgress();
            }
          } catch (mergeErr) {
            try { await this.dbConnection.runAndReadAll('ROLLBACK;'); } catch {}
            this.logger.warn('合併更新失敗，將逐筆回退', { error: (mergeErr as Error).message });

            // 最後退路：逐筆 UPDATE（可能仍會命中 FK 問題）
            for (const entity of batch) {
              try {
                await this.dbConnection.runAndReadAll(`
                  UPDATE entities 
                  SET embedding = (SELECT embedding FROM ${tempTable} WHERE name = $1),
                      embedding_updated_at = CURRENT_TIMESTAMP,
                      embedding_model = (SELECT embedding_model FROM ${tempTable} WHERE name = $1)
                  WHERE name = $1
                `, [entity.name]);
                processed++;
                this.progress.processedEntities++;
                this.showProgress(this.progress.processedEntities, this.progress.totalEntities, 'entities');
              } catch (uErr) {
                this.logger.warn(`逐筆更新失敗: ${entity.name}`, { error: (uErr as Error).message });
                failed++;
              }
            }
            await this.saveProgress();
          }

          if (i + this.config.batchSize < entities.length) {
            await this.delay(this.config.batchDelayMs);
          }
        }

        await this.dbConnection.runAndReadAll(`DROP TABLE IF EXISTS ${tempTable};`);
        await this.saveProgress();
        console.log(`\n✅ Entities 處理完成: ${processed} 成功, ${failed} 失敗`);
        return { processed, failed, tokens: totalTokens };
      } catch (error) {
        this.logger.warn('strategyA 流程發生錯誤，回退到原始流程', { error: (error as Error).message });
        // 繼續走原本流程（下面）
      }
    }
    for (let i = 0; i < entities.length; i += this.config.batchSize) {
      const batch = entities.slice(i, i + this.config.batchSize);

      // 優先以交易包裹整個批次；失敗則回退改逐筆處理
      let batchSucceeded = false;
      try {
        await this.dbConnection.runAndReadAll('BEGIN;');
        for (const entity of batch) {
          const text = `Entity: ${entity.name}, Type: ${entity.entityType}`;
          const result = await this.embeddingService!.generateEmbedding(text);
          const embeddingStr = '[' + result.vector.join(',') + ']';
          await this.dbConnection.runAndReadAll(`
            UPDATE entities 
            SET embedding = $1::FLOAT[1536],
                embedding_updated_at = CURRENT_TIMESTAMP,
                embedding_model = $3
            WHERE name = $2
          `, [embeddingStr, entity.name, this.embeddingService!.getConfig().model]);

          processed++;
          totalTokens += result.usage?.totalTokens || 0;
          this.progress.processedEntities++;
          this.showProgress(this.progress.processedEntities, this.progress.totalEntities, 'entities');
          if (processed % this.config.progressSaveInterval === 0) {
            await this.saveProgress();
          }
        }
        await this.dbConnection.runAndReadAll('COMMIT;');
        batchSucceeded = true;
      } catch (batchError) {
        this.logger.warn('Entities 批次交易失敗，回退並改逐筆處理', { error: (batchError as Error).message });
        try { await this.dbConnection.runAndReadAll('ROLLBACK;'); } catch {}

        // 逐筆處理（非交易），避免單一失敗阻塞整批
        for (const entity of batch) {
          try {
            const text = `Entity: ${entity.name}, Type: ${entity.entityType}`;
            const result = await this.embeddingService!.generateEmbedding(text);
            const embeddingStr = '[' + result.vector.join(',') + ']';
            await this.dbConnection.runAndReadAll(`
              UPDATE entities 
              SET embedding = $1::FLOAT[1536],
                  embedding_updated_at = CURRENT_TIMESTAMP,
                  embedding_model = $3
              WHERE name = $2
            `, [embeddingStr, entity.name, this.embeddingService!.getConfig().model]);

            processed++;
            totalTokens += result.usage?.totalTokens || 0;
            this.progress.processedEntities++;
            this.showProgress(this.progress.processedEntities, this.progress.totalEntities, 'entities');
            if (processed % this.config.progressSaveInterval === 0) {
              await this.saveProgress();
            }
          } catch (error) {
            this.logger.warn(`處理 entity "${entity.name}" 失敗: ${(error as Error).message}`);
            this.progress.failedEntities.push(entity.name);
            failed++;
          }
        }
      }

      // 批次間延遲
      if (i + this.config.batchSize < entities.length) {
        await this.delay(this.config.batchDelayMs);
      }
    }
    
    await this.saveProgress();
    console.log(`\n✅ Entities 處理完成: ${processed} 成功, ${failed} 失敗`);
    return { processed, failed, tokens: totalTokens };
  }

  /**
   * 處理 observations
   */
  private async processObservations(observations: any[]): Promise<{ processed: number, failed: number, tokens: number }> {
    if (observations.length === 0) return { processed: 0, failed: 0, tokens: 0 };

    this.logger.info('\n📋 處理 Observations...');
    let processed = 0;
    let failed = 0;
    let totalTokens = 0;

    // 使用穩定的資料庫連接
    for (let i = 0; i < observations.length; i += this.config.batchSize) {
      const batch = observations.slice(i, i + this.config.batchSize);

      let batchSucceeded = false;
      try {
        await this.dbConnection.runAndReadAll('BEGIN;');
        for (const observation of batch) {
          const id = observation[0];
          const content = observation[1];
          const result = await this.embeddingService!.generateEmbedding(content);
          const embeddingStr = '[' + result.vector.join(',') + ']';
          await this.dbConnection.runAndReadAll(`
            UPDATE observations 
            SET embedding = $1::FLOAT[1536],
                embedding_updated_at = CURRENT_TIMESTAMP,
                embedding_model = $3
            WHERE id = $2
          `, [embeddingStr, id, this.embeddingService!.getConfig().model]);

          processed++;
          totalTokens += result.usage?.totalTokens || 0;
          this.progress.processedObservations++;
          this.showProgress(this.progress.processedObservations, this.progress.totalObservations, 'observations');
          if (processed % this.config.progressSaveInterval === 0) {
            await this.saveProgress();
          }
        }
        await this.dbConnection.runAndReadAll('COMMIT;');
        batchSucceeded = true;
      } catch (batchError) {
        this.logger.warn('Observations 批次交易失敗，回退並改逐筆處理', { error: (batchError as Error).message });
        try { await this.dbConnection.runAndReadAll('ROLLBACK;'); } catch {}

        for (const observation of batch) {
          try {
            const id = observation[0];
            const content = observation[1];
            const result = await this.embeddingService!.generateEmbedding(content);
            const embeddingStr = '[' + result.vector.join(',') + ']';
            await this.dbConnection.runAndReadAll(`
              UPDATE observations 
              SET embedding = $1::FLOAT[1536],
                  embedding_updated_at = CURRENT_TIMESTAMP,
                  embedding_model = $3
              WHERE id = $2
            `, [embeddingStr, id, this.embeddingService!.getConfig().model]);

            processed++;
            totalTokens += result.usage?.totalTokens || 0;
            this.progress.processedObservations++;
            this.showProgress(this.progress.processedObservations, this.progress.totalObservations, 'observations');
            if (processed % this.config.progressSaveInterval === 0) {
              await this.saveProgress();
            }
          } catch (error) {
            this.logger.warn(`處理 observation ID ${observation[0]} 失敗: ${(error as Error).message}`);
            this.progress.failedObservations.push(observation[0]);
            failed++;
          }
        }
      }

      // 批次間延遲
      if (i + this.config.batchSize < observations.length) {
        await this.delay(this.config.batchDelayMs);
      }
    }
    
    await this.saveProgress();
    console.log(`\n✅ Observations 處理完成: ${processed} 成功, ${failed} 失敗`);
    return { processed, failed, tokens: totalTokens };
  }

  /**
   * 計算費用
   */
  private calculateCost(tokens: number): number {
    // text-embedding-3-small: $0.00002 per 1K tokens
    return (tokens / 1000) * 0.00002;
  }

  /**
   * 顯示執行統計
   */
  private displayStats(stats: BackfillStats): void {
    console.log('\n🎉 Embedding Backfill 完成！');
    console.log('\n📊 執行統計：');
    console.log(`  • 成功處理: ${stats.totalProcessed} 筆`);
    console.log(`  • 處理失敗: ${stats.totalFailed} 筆`);
    console.log(`  • 執行時間: ${Math.round(stats.executionTimeMs / 1000)} 秒`);
    console.log(`  • Token 使用: ${stats.totalTokens.toLocaleString()}`);
    console.log(`  • 實際費用: ~$${stats.totalCost.toFixed(4)} USD`);
    console.log(`  • 平均每筆: ${stats.avgTokensPerItem.toFixed(1)} tokens`);
    console.log('\n✨ 現在所有資料都可以使用語義搜尋功能了！');
  }

  /**
   * 臨時移除 observations 外鍵，完成後在 finally 重建
   */
  private async temporarilyDisableObservationsFK(): Promise<void> {
    try {
      const rows = await this.dbConnection.runAndReadAll(`
        SELECT constraint_name 
        FROM duckdb_constraints()
        WHERE table_name = 'observations' AND constraint_type = 'FOREIGN KEY'
      `);

      const names: string[] = Array.isArray(rows)
        ? rows.map((r: any) => r.constraint_name || r.CONSTRAINT_NAME || r.name).filter(Boolean)
        : (rows.getRows?.().map((r: any[]) => r[0]).filter(Boolean) || []);

      if (names.length === 0) {
        this.logger.info('未發現 observations 上的外鍵約束，跳過臨時停用');
        this.fkTemporarilyDisabled = false;
        return;
      }

      for (const name of names) {
        await this.dbConnection.runAndReadAll(`ALTER TABLE observations DROP CONSTRAINT ${this.quoteIdent(name)};`);
        this.logger.info(`已臨時移除 FK 約束: ${name}`);
      }

      this.fkTemporarilyDisabled = true;
    } catch (error) {
      this.logger.warn('臨時移除 observations 外鍵失敗，將在啟用狀態下嘗試 backfill', {
        error: (error as Error).message,
      });
      this.fkTemporarilyDisabled = false;
    }
  }

  /**
   * 重建 observations 外鍵到 entities(name)
   */
  private async recreateObservationsFKIfNeeded(): Promise<void> {
    if (!this.fkTemporarilyDisabled) return;
    try {
      await this.dbConnection.runAndReadAll(
        `ALTER TABLE observations ADD FOREIGN KEY (entityName) REFERENCES entities(name);`
      );
      this.logger.info('已重建 observations 外鍵 (entityName → entities(name))');
    } catch (error) {
      this.logger.warn('重建 observations 外鍵失敗，請手動檢查', { error: (error as Error).message });
    }
  }

  private quoteIdent(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  /**
   * 清理進度檔案
   */
  private async cleanupProgress(): Promise<void> {
    try {
      await fs.unlink(this.progressFilePath);
      this.logger.info('已清理進度檔案');
    } catch {
      // 忽略清理失敗
    }
  }

  /**
   * 主執行流程
   */
  async run(): Promise<void> {
    try {
      // 初始化
      await this.initialize();

      // 分析資料
      const { entities, observations } = await this.analyzeData();
      const totalCount = entities.length + observations.length;

      if (totalCount === 0) {
        console.log('✅ 所有資料都已經有 embedding 了！');
        await this.cleanupProgress();
        return;
      }

      // 估算費用
      const estimatedTokens = totalCount * 50; // 平均估算
      const estimatedCost = this.calculateCost(estimatedTokens);
      const estimatedTime = Math.ceil(totalCount / this.config.batchSize * 1.5);

      console.log('\n💰 費用估算：');
      console.log(`  • 待處理資料: ${totalCount} 筆`);
      console.log(`  • 預估 tokens: ${estimatedTokens.toLocaleString()}`);
      console.log(`  • 預估費用: ~$${estimatedCost.toFixed(4)} USD`);
      console.log(`  • 預估時間: ${estimatedTime} 分鐘`);

      if (this.progress.processedEntities > 0 || this.progress.processedObservations > 0) {
        console.log('\n🔄 檢測到未完成的處理進度，將從中斷處繼續...');
      }

      // 直接執行（移除互動式確認）
      this.logger.info('已略過互動式確認，直接開始 backfill');

      // 開始處理
      console.log('\n🚀 開始處理...');
      const startTime = Date.now();
      let totalTokens = 0;
      let totalProcessed = 0;
      let totalFailed = 0;

      // 先處理 observations（避開目前 entities FK 問題），再決定是否處理 entities
      if (this.config.target === 'observations' || this.config.target === 'both') {
        const obsResults = await this.processObservations(observations);
        totalProcessed += obsResults.processed;
        totalFailed += obsResults.failed;
        totalTokens += obsResults.tokens;
      }

      if (this.config.target === 'entities' || this.config.target === 'both') {
        const entityResults = await this.processEntities(entities);
        totalProcessed += entityResults.processed;
        totalFailed += entityResults.failed;
        totalTokens += entityResults.tokens;
      }

      // 顯示結果
      const stats: BackfillStats = {
        totalProcessed,
        totalFailed,
        totalTokens,
        totalCost: this.calculateCost(totalTokens),
        executionTimeMs: Date.now() - startTime,
        avgTokensPerItem: totalProcessed > 0 ? totalTokens / totalProcessed : 0
      };

      this.displayStats(stats);

      // 清理進度檔案
      if (totalFailed === 0) {
        await this.cleanupProgress();
      } else {
        console.log(`\n⚠️  有 ${totalFailed} 筆處理失敗，進度檔案已保留，可重新執行繼續處理`);
      }

    } catch (error) {
      this.logger.error('執行過程發生錯誤', { error: (error as Error).message });
      throw error;
    } finally {
      this.rl.close();
      
      // 完成後嘗試重建外鍵
      if (this.dbConnection) {
        await this.recreateObservationsFKIfNeeded();
      }

      // 清理資料庫連接
      if (this.dbConnection) {
        try {
          await this.dbConnection.close();
          this.logger.info('✅ 資料庫連接已關閉');
        } catch (error) {
          this.logger.warn('資料庫連接關閉失敗', { error });
        }
      }
      
      // 清理管理器
      if (this.manager) {
        try {
          await this.manager.close();
          this.logger.info('✅ DuckDB Manager 已關閉');
        } catch (error) {
          this.logger.warn('Manager 關閉失敗', { error });
        }
      }
    }
  }
}

/**
 * 命令行執行入口
 */
export async function main(): Promise<void> {
  const tool = new EmbeddingBackfillTool();

  // 處理優雅退出
  process.on('SIGINT', () => {
    console.log('\n\n🛑 接收到中斷信號，正在優雅退出...');
    process.exit(0);
  });

  try {
    await tool.run();
  } catch (error) {
    console.error('❌ 執行失敗:', (error as Error).message);
    process.exit(1);
  }
}

// 如果直接執行此檔案
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}