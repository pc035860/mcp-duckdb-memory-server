#!/usr/bin/env tsx

/**
 * Manual verification script for migration logic
 * Run with: npx tsx tests/validation/verify-migration.ts
 */

import { DuckDBKnowledgeGraphManager } from '../../src/managers/duckdb-manager.js';
import { ConsoleLogger } from '../../src/logger.js';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function verifyMigration() {
  const testDbPath = join(tmpdir(), 'test-migration-verify.db');
  
  // Clean up any existing test database
  if (existsSync(testDbPath)) {
    rmSync(testDbPath, { force: true });
  }
  const walPath = `${testDbPath}.wal`;
  if (existsSync(walPath)) {
    rmSync(walPath, { force: true });
  }

  console.log('\n=== Migration Verification Test ===\n');
  
  const logger = new ConsoleLogger();
  
  try {
    // Test 1: Concurrent migration handling
    console.log('Test 1: Testing concurrent migration attempts...');
    const manager1 = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      1000
    );
    
    await manager1.initialize();
    
    // Attempt concurrent migrations
    const migrations = [
      manager1['migrateObservationsTable'](),
      manager1['migrateObservationsTable'](),
      manager1['migrateObservationsTable']()
    ];
    
    await Promise.all(migrations);
    console.log('✅ Concurrent migrations handled successfully\n');
    
    await manager1.close();
    
    // Test 2: Migration state management
    console.log('Test 2: Testing migration state management...');
    const manager2 = new DuckDBKnowledgeGraphManager(
      () => testDbPath,
      logger,
      false,
      1000
    );
    
    await manager2.initialize();
    
    // Check migration state
    const migrationInProgress = manager2['migrationInProgress'];
    const migrationLock = manager2['migrationLock'];
    
    console.log(`Migration in progress: ${migrationInProgress}`);
    console.log(`Migration lock: ${migrationLock}`);
    
    if (!migrationInProgress && migrationLock === null) {
      console.log('✅ Migration state properly cleared\n');
    } else {
      console.log('❌ Migration state not properly cleared\n');
    }
    
    // Test 3: Data integrity after migration
    console.log('Test 3: Testing data integrity...');
    await manager2.createEntities([{
      name: 'test_entity',
      entityType: 'test_type',
      observations: ['observation1', 'observation2']
    }]);
    
    const graph = await manager2.openNodes(['test_entity']);
    if (graph.entities.length === 1 && 
        graph.entities[0].observations.length === 2) {
      console.log('✅ Data integrity maintained after migration\n');
    } else {
      console.log('❌ Data integrity issue detected\n');
    }
    
    // Test 4: Verify indexes were created
    console.log('Test 4: Checking indexes...');
    const conn = await manager2['getConnection']();
    const result = await conn.runAndReadAll(`
      SELECT sql FROM sqlite_master 
      WHERE type='index' AND tbl_name='observations'
    `);
    
    const indexes = result.getRows();
    if (indexes.length >= 2) {
      console.log(`✅ Found ${indexes.length} indexes on observations table`);
      indexes.forEach((idx, i) => {
        console.log(`  Index ${i + 1}: ${idx.sql}`);
      });
    } else {
      console.log(`⚠️ Only ${indexes.length} indexes found on observations table`);
    }
    
    await manager2.close();
    
    console.log('\n=== All tests completed ===\n');
    
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    // Clean up
    if (existsSync(testDbPath)) {
      rmSync(testDbPath, { force: true });
    }
    const walPath = `${testDbPath}.wal`;
    if (existsSync(walPath)) {
      rmSync(walPath, { force: true });
    }
  }
  
  process.exit(0);
}

// Run verification
verifyMigration().catch(console.error);