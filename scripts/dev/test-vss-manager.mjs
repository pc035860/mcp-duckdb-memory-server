#!/usr/bin/env node

import { DuckDBKnowledgeGraphManager } from './dist/chunk-SMZ6ONZW.mjs';
import { ConsoleLogger } from './dist/chunk-HP3ZLAWX.mjs';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';

const testDir = mkdtempSync(path.join(tmpdir(), 'vss-test-'));
const testDbPath = path.join(testDir, 'test.db');

console.log('🧪 Testing VSS Manager embedding update...');
console.log(`📁 Test database: ${testDbPath}`);

const logger = new ConsoleLogger();
logger.setLevel('debug');

// 使用假 key，但允許初始化
process.env.OPENAI_API_KEY = 'sk-fake-key-for-testing';
process.env.EMBEDDING_AUTO_GENERATE = 'false';

let manager = null;

try {
  manager = new DuckDBKnowledgeGraphManager(
    () => testDbPath,
    logger,
    false,
    1000
  );

  // 跳過 VSS 初始化，直接初始化基本功能
  await manager.initializeBasic?.() || await manager.initialize().catch(() => {
    console.log('⚠️ Full initialization failed, continuing with basic setup...');
  });
  
  console.log('✅ Manager basic initialization completed');

  // 創建測試實體
  await manager.createEntities([{
    name: 'vss_test_entity',
    entityType: 'debug',
    observations: ['test observation for vss']
  }]);
  
  console.log('✅ Test entity created');

  // 獲取 VSS Manager (如果存在)
  const vssManager = manager.vssManager || manager.getVSSManager?.();
  
  if (vssManager) {
    console.log('🧪 Testing VSSManager updateEntityEmbeddingInDB...');
    
    const fakeEmbedding = new Array(1536).fill(0.2);
    console.log(`Fake embedding: [${fakeEmbedding.slice(0,5).join(', ')}...] (length: ${fakeEmbedding.length})`);
    
    // 直接調用 VSSManager 的 updateEntityEmbeddingInDB 方法
    await vssManager.updateEntityEmbeddingInDB('vss_test_entity', fakeEmbedding);
    
    console.log('✅ VSSManager embedding update succeeded!');
  } else {
    console.log('❌ VSSManager not available');
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
