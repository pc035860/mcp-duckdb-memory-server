#!/usr/bin/env node

import { DuckDBKnowledgeGraphManager } from './dist/chunk-SMZ6ONZW.mjs';
import { ConsoleLogger } from './dist/chunk-HP3ZLAWX.mjs';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';

const testDir = mkdtempSync(path.join(tmpdir(), 'sql-debug-'));
const testDbPath = path.join(testDir, 'test.db');

console.log('🔧 Debug SQL types...');
console.log(`📁 Test database: ${testDbPath}`);

const logger = new ConsoleLogger();
logger.setLevel('debug');

// 不使用真實的 OpenAI key，但設定一個假的來測試
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

  await manager.initialize();
  console.log('✅ Manager initialized');

  // 手動測試 SQL 參數類型
  console.log('🧪 Testing SQL parameter types...');
  
  // 創建一個測試實體
  await manager.createEntities([{
    name: 'test_entity',
    entityType: 'debug',
    observations: ['test observation']
  }]);
  
  console.log('✅ Test entity created');

  // 手動測試 embedding 更新（使用假的向量）
  const connection = await manager.getConnection();
  const fakeEmbedding = new Array(1536).fill(0.1); // 假的 1536 維向量
  
  console.log('🧪 Testing direct SQL with fake embedding...');
  console.log(`Fake embedding length: ${fakeEmbedding.length}`);
  console.log(`Fake embedding type: ${typeof fakeEmbedding[0]}`);
  
  const sql = `
    UPDATE entities 
    SET embedding = $2::FLOAT[], 
        embedding_updated_at = CURRENT_TIMESTAMP,
        embedding_model = $3
    WHERE name = $1
  `;
  
  console.log('SQL:', sql);
  console.log('Parameters:', ['test_entity', fakeEmbedding, 'test-model']);
  
  await connection.runAndReadAll(sql, [
    'test_entity',
    fakeEmbedding,
    'test-model'
  ]);
  
  console.log('✅ Direct SQL update succeeded!');

} catch (error) {
  console.error('❌ Error:', error);
} finally {
  if (manager) {
    await manager.close();
  }
  rmSync(testDir, { recursive: true, force: true });
}
