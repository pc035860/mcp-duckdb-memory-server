#!/usr/bin/env node

/**
 * Test script for non-blocking embedding generation functionality
 * This script verifies that the EmbeddingQueueManager integration works correctly
 */

import { DuckDBKnowledgeGraphManager } from './dist/chunk-TQQWWHLQ.mjs';
import { ConsoleLogger } from './dist/chunk-HP3ZLAWX.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create temporary directory for test database
const testDir = mkdtempSync(path.join(tmpdir(), 'embedding-test-'));
const testDbPath = path.join(testDir, 'test-embedding.db');

console.log('🧪 Testing non-blocking embedding generation...');
console.log(`📁 Test database: ${testDbPath}`);

// Initialize logger with debug level
const logger = new ConsoleLogger();

// Set required environment variables for testing
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_key_placeholder';
process.env.EMBEDDING_AUTO_GENERATE = 'true';
process.env.EMBEDDING_DEBOUNCE_MS = '1000'; // Shorter for testing
process.env.EMBEDDING_BATCH_SIZE = '5';
process.env.DEBUG = '1';

let manager = null;

try {
  // Create manager instance
  console.log('🔧 Initializing DuckDBManager...');
  manager = new DuckDBKnowledgeGraphManager(
    () => testDbPath,
    logger,
    false, // allowExternalTimestamps
    1000   // entityCountThreshold
  );

  // Initialize the manager
  await manager.initialize();
  console.log('✅ Manager initialized');

  // Check if VSS services are available
  const vssAvailable = manager.isVSSAvailable();
  console.log(`🔍 VSS services available: ${vssAvailable}`);

  // Get embedding service
  const embeddingService = manager.getEmbeddingService();
  console.log(`🤖 Embedding service: ${embeddingService ? 'Available' : 'Not available'}`);

  // Check embedding queue status
  const queueStatus = manager.getEmbeddingQueueStatus();
  console.log('📊 Initial queue status:', JSON.stringify(queueStatus, null, 2));

  // Create test entities to trigger embedding generation
  console.log('📝 Creating test entities...');
  const testEntities = [
    {
      name: 'test_user_authentication',
      entityType: 'system',
      observations: ['Handles user login and logout', 'Uses JWT tokens for authentication']
    },
    {
      name: 'test_data_processing',
      entityType: 'module',
      observations: ['Processes user data', 'Validates input and sanitizes output']
    },
    {
      name: 'test_api_endpoints',
      entityType: 'service',
      observations: ['RESTful API design', 'Handles HTTP requests and responses']
    }
  ];

  const createdEntities = await manager.createEntities(testEntities);
  console.log(`✅ Created ${createdEntities.length} entities`);

  // Check queue status after entity creation
  const queueStatusAfterCreate = manager.getEmbeddingQueueStatus();
  console.log('📊 Queue status after creation:', JSON.stringify(queueStatusAfterCreate, null, 2));

  // Add additional observations to trigger more embedding generation
  console.log('📝 Adding observations...');
  const additionalObservations = [
    {
      entityName: 'test_user_authentication',
      contents: ['Supports OAuth 2.0 integration', 'Password reset functionality']
    },
    {
      entityName: 'test_data_processing',
      contents: ['Batch processing capabilities', 'Real-time data streaming']
    }
  ];

  const addedObservations = await manager.addObservations(additionalObservations);
  console.log(`✅ Added observations to ${addedObservations.length} entities`);

  // Check final queue status
  const finalQueueStatus = manager.getEmbeddingQueueStatus();
  console.log('📊 Final queue status:', JSON.stringify(finalQueueStatus, null, 2));

  // Wait a moment for any debounced operations to complete
  console.log('⏳ Waiting for debounced operations...');
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Wait additional time to ensure embedding processing completes
  console.log('⏳ Waiting for embedding processing to complete...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check operation status
  const operationStatus = manager.getOperationStatus();
  console.log('🔧 Operation status:', JSON.stringify(operationStatus, null, 2));

  console.log('✅ Test completed successfully!');

  // Summary
  console.log('\n📋 Test Summary:');
  console.log(`- Created ${createdEntities.length} entities with observations`);
  console.log(`- Added observations to ${addedObservations.length} entities`);
  console.log(`- VSS services ${vssAvailable ? 'enabled' : 'disabled'}`);
  console.log(`- Embedding auto-generation ${queueStatus.config?.autoGenerate ? 'enabled' : 'disabled'}`);
  
  if (queueStatus.config) {
    console.log(`- Debounce delay: ${queueStatus.config.debounceMs}ms`);
    console.log(`- Batch size: ${queueStatus.config.batchSize}`);
    console.log(`- Max retries: ${queueStatus.config.maxRetries}`);
  }

} catch (error) {
  console.error('❌ Test failed:', error);
  process.exit(1);
} finally {
  // Cleanup
  if (manager) {
    try {
      await manager.close();
      console.log('🧹 Manager closed');
    } catch (closeError) {
      console.warn('⚠️ Error closing manager:', closeError);
    }
  }

  try {
    rmSync(testDir, { recursive: true, force: true });
    console.log('🧹 Test directory cleaned up');
  } catch (cleanupError) {
    console.warn('⚠️ Error cleaning up test directory:', cleanupError);
  }
}

console.log('🎉 Non-blocking embedding generation test complete!');