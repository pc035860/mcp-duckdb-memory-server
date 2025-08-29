#!/usr/bin/env node

/**
 * Simple test to isolate the connection issue
 */

import { DuckDBKnowledgeGraphManager } from './dist/chunk-SSMXJWRC.mjs';
import { ConsoleLogger } from './dist/chunk-HP3ZLAWX.mjs';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';

const testDir = mkdtempSync(path.join(tmpdir(), 'simple-test-'));
const testDbPath = path.join(testDir, 'test.db');

console.log('🧪 Simple test...');

const logger = new ConsoleLogger();
logger.setLevel('debug');

// Disable OpenAI calls for now
process.env.OPENAI_API_KEY = '';
process.env.EMBEDDING_AUTO_GENERATE = 'false';

let manager = null;

try {
  manager = new DuckDBKnowledgeGraphManager(
    () => testDbPath,
    logger,
    false,
    1000
  );

  console.log('🔧 Initializing...');
  await manager.initialize();
  
  console.log('✅ Manager initialized');
  console.log(`📊 Connection: ${manager.connection ? 'Available' : 'Not available'}`);
  
  // Test embedding queue status
  const queueStatus = manager.getEmbeddingQueueStatus();
  console.log('📊 Queue status:', JSON.stringify(queueStatus, null, 2));

  console.log('✅ Simple test passed!');

} catch (error) {
  console.error('❌ Test failed:', error);
} finally {
  if (manager) {
    await manager.close();
  }
  rmSync(testDir, { recursive: true, force: true });
}