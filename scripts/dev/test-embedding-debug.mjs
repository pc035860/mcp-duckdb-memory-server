#!/usr/bin/env node

import { DuckDBKnowledgeGraphManager } from './dist/chunk-SMZ6ONZW.mjs';
import { ConsoleLogger } from './dist/chunk-HP3ZLAWX.mjs';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';

const testDir = mkdtempSync(path.join(tmpdir(), 'embedding-debug-'));
const testDbPath = path.join(testDir, 'debug.db');

console.log('🔍 Debugging DuckDB FLOAT[] type conversion...');
console.log(`📁 Test database: ${testDbPath}`);

const logger = new ConsoleLogger();
logger.setLevel('debug');

// 使用假 key，但讓它接近真實格式以通過基本檢查
process.env.OPENAI_API_KEY = 'sk-fake-but-longer-key-for-health-check-bypass-testing-1234567890';
process.env.EMBEDDING_AUTO_GENERATE = 'true';
process.env.EMBEDDING_DEBOUNCE_MS = '500';  // 短一點快速測試

let manager = null;

try {
  manager = new DuckDBKnowledgeGraphManager(
    () => testDbPath,
    logger,
    false,
    1000
  );

  // 初始化 manager
  await manager.initialize();
  console.log('✅ Manager initialized');

  // 檢查 VSS 服務狀態
  const vssAvailable = manager.isVSSAvailable?.() || false;
  console.log(`🔍 VSS services available: ${vssAvailable}`);

  // 如果 VSS 可用，我們來手動測試類型轉換
  if (vssAvailable) {
    console.log('🧪 Testing direct embedding vector operations...');
    
    // 創建測試實體
    await manager.createEntities([{
      name: 'debug_entity',
      entityType: 'test',
      observations: ['test observation for debugging']
    }]);
    
    console.log('✅ Created test entity');
    
    // 獲取 EmbeddingQueueManager（如果可用）
    const queueManager = manager.embeddingQueueManager;
    
    if (queueManager) {
      console.log('🔧 Testing EmbeddingQueueManager direct operations...');
      
      // 測試不同格式的 embedding 向量
      const testVectors = [
        {
          name: 'JavaScript Array',
          vector: new Array(1536).fill(0.123456)
        },
        {
          name: 'Float32Array',  
          vector: new Float32Array(1536).fill(0.123456)
        },
        {
          name: 'Plain array with explicit conversion',
          vector: Array.from({ length: 1536 }, () => 0.123456)
        }
      ];
      
      for (const test of testVectors) {
        console.log(`\n🧪 Testing ${test.name}...`);
        console.log(`Vector type: ${test.vector.constructor.name}`);
        console.log(`Vector length: ${test.vector.length}`);
        console.log(`Sample values: [${test.vector.slice(0, 5).join(', ')}...]`);
        
        try {
          // 嘗試直接調用資料庫更新方法
          await queueManager.updateEntityEmbeddingInDB('debug_entity', test.vector);
          console.log(`✅ ${test.name}: Success!`);
          break; // 成功就不需要測試其他格式了
        } catch (error) {
          console.log(`❌ ${test.name}: ${error.message}`);
        }
      }
    } else {
      console.log('❌ EmbeddingQueueManager not available');
    }
    
  } else {
    console.log('❌ VSS services not available, cannot test embedding operations');
  }

} catch (error) {
  console.error('❌ Error:', error.message);
  console.error('Full error:', error);
} finally {
  if (manager) {
    await manager.close();
  }
  rmSync(testDir, { recursive: true, force: true });
}