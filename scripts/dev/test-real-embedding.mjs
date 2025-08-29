#!/usr/bin/env node

import { DuckDBKnowledgeGraphManager } from './dist/chunk-TQQWWHLQ.mjs';
import { ConsoleLogger } from './dist/chunk-HP3ZLAWX.mjs';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';

// 檢查是否有真實的 OpenAI API key
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith('sk-fake')) {
  console.log('❌ 需要真實的 OpenAI API key 來測試向量格式');
  console.log('請設定 OPENAI_API_KEY 環境變數');
  process.exit(1);
}

const testDir = mkdtempSync(path.join(tmpdir(), 'real-embedding-test-'));
const testDbPath = path.join(testDir, 'test.db');

console.log('🧪 Testing with real OpenAI API for embedding vector format analysis...');
console.log(`📁 Test database: ${testDbPath}`);
console.log(`🔑 Using OpenAI API key: ${process.env.OPENAI_API_KEY.substring(0, 7)}...`);

const logger = new ConsoleLogger();
logger.setLevel('debug');

// 配置環境變數
process.env.EMBEDDING_AUTO_GENERATE = 'true';
process.env.EMBEDDING_DEBOUNCE_MS = '1000';  // 1秒 debounce
process.env.EMBEDDING_BATCH_SIZE = '2';      // 小批次測試

let manager = null;

try {
  manager = new DuckDBKnowledgeGraphManager(
    () => testDbPath,
    logger,
    false,
    1000
  );

  console.log('🔧 Initializing with real OpenAI API...');
  await manager.initialize();
  console.log('✅ Manager initialized');

  // 檢查 VSS 服務狀態
  const vssAvailable = manager.isVSSAvailable?.() || false;
  console.log(`🔍 VSS services available: ${vssAvailable}`);

  if (!vssAvailable) {
    console.log('❌ VSS services not available, cannot test embedding operations');
    process.exit(1);
  }

  // 創建測試實體 - 將觸發 embedding 生成
  console.log('📝 Creating test entities to trigger embedding generation...');
  await manager.createEntities([{
    name: 'debug_embedding_entity',
    entityType: 'debug_test',
    observations: ['This is a test observation for debugging embedding vector format in DuckDB']
  }]);

  console.log('✅ Created test entity');
  console.log('⏳ Waiting for embedding generation and debugging output...');

  // 等待 debounce 完成和處理
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('🔍 Checking final results...');
  
  // 檢查是否成功生成 embedding
  try {
    const entities = await manager.getAllEntities();
    const testEntity = entities.find(e => e.name === 'debug_embedding_entity');
    if (testEntity) {
      console.log('📊 Test entity found:', {
        name: testEntity.name,
        hasObservations: testEntity.observations && testEntity.observations.length > 0
      });
    }
  } catch (error) {
    console.log('⚠️ Error checking final results:', error.message);
  }

  console.log('✅ Test completed - check debug logs above for embedding vector format details');

} catch (error) {
  console.error('❌ Error:', error.message);
  console.error('Full error:', error);
} finally {
  if (manager) {
    await manager.close();
  }
  rmSync(testDir, { recursive: true, force: true });
  console.log('🧹 Cleanup complete');
}