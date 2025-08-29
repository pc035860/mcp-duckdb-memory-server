#!/usr/bin/env node

import { DuckDBKnowledgeGraphManager } from './dist/chunk-SBA7LUBV.mjs';
import { ConsoleLogger } from './dist/chunk-HP3ZLAWX.mjs';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';

const testDir = mkdtempSync(path.join(tmpdir(), 'debug-test-'));
const testDbPath = path.join(testDir, 'test.db');

console.log('🔧 Debug embedding SQL...');
console.log(`📁 Test database: ${testDbPath}`);

const logger = new ConsoleLogger();
logger.setLevel('debug');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_key_placeholder';
process.env.EMBEDDING_AUTO_GENERATE = 'false'; // 關閉自動生成

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

  // 檢查 entity_embeddings 表是否存在
  const hasEntityEmbeddings = await manager.checkEntityEmbeddingsTableExists();
  console.log(`📊 Entity embeddings table exists: ${hasEntityEmbeddings}`);

  // 檢查 VSS 是否可用
  const vssAvailable = manager.isVSSAvailable();
  console.log(`🔍 VSS available: ${vssAvailable}`);

} catch (error) {
  console.error('❌ Error:', error);
} finally {
  if (manager) {
    await manager.close();
  }
  rmSync(testDir, { recursive: true, force: true });
}
