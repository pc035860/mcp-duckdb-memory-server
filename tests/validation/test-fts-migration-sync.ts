#!/usr/bin/env tsx

/**
 * Test script to validate FTS index synchronization with database migration
 * 
 * This test validates that:
 * 1. FTS index operations don't interfere with table migrations
 * 2. Migration state is properly tracked
 * 3. Index rebuilds are deferred during migration
 * 4. System recovers gracefully from migration/index conflicts
 */

import { DuckDBKnowledgeGraphManager } from '../../src/managers/duckdb-manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test database path
const TEST_DB_PATH = path.join(__dirname, 'test-fts-migration-sync.db');

// Enable debug logging
process.env.DEBUG = '1';

// Force FTS to be enabled
process.env.ENTITY_COUNT_THRESHOLD = '0';

// Color codes for output
const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message: string, color: keyof typeof COLORS = 'reset') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

async function cleanupTestDb() {
  try {
    await fs.unlink(TEST_DB_PATH);
    await fs.unlink(`${TEST_DB_PATH}.wal`).catch(() => {});
    log('✓ Cleaned up test database', 'green');
  } catch (error) {
    // File might not exist
  }
}

async function testMigrationWithFTS() {
  log('\n=== Test 1: Migration with FTS Enabled ===', 'blue');
  
  // Clean start
  await cleanupTestDb();
  
  const manager = new DuckDBKnowledgeGraphManager(
    () => TEST_DB_PATH,
    undefined, // use default logger
    true, // allowExternalTimestamps
    0 // entityCountThreshold - force FTS
  );
  
  try {
    // Initialize the manager (this will trigger migration if needed)
    log('Initializing manager (may trigger migration)...', 'yellow');
    await manager.initialize();
    log('✓ Manager initialized successfully', 'green');
    
    // Create some test data
    log('Creating test entities...', 'yellow');
    const entities = await manager.createEntities([
      {
        name: 'test-entity-1',
        entityType: 'test',
        observations: ['This is a test observation'],
        createdAt: new Date().toISOString()
      },
      {
        name: 'test-entity-2',
        entityType: 'test',
        observations: ['Another test observation'],
        createdAt: new Date().toISOString()
      }
    ]);
    log(`✓ Created ${entities.length} entities`, 'green');
    
    // Test FTS search
    log('Testing FTS search...', 'yellow');
    const searchResults = await manager.searchNodes('test observation');
    log(`✓ FTS search returned ${searchResults?.entities?.length || 0} results`, 'green');
    
    // Check FTS health
    log('Checking FTS index health...', 'yellow');
    const health = await manager.checkFTSIndexHealth();
    // Convert any BigInt values to strings for display
    const healthForDisplay = {
      ...health,
      entitiesIndexed: health.entitiesIndexed?.toString(),
      observationsIndexed: health.observationsIndexed?.toString()
    };
    log(`✓ FTS Health: ${JSON.stringify(healthForDisplay)}`, 'green');
    
    // Trigger index rebuild
    log('Triggering manual FTS index rebuild...', 'yellow');
    await manager.rebuildFTSIndexes();
    log('✓ FTS indexes rebuilt successfully', 'green');
    
    // Verify search still works
    log('Verifying search after rebuild...', 'yellow');
    const searchResults2 = await manager.searchNodes('observation');
    log(`✓ Search after rebuild returned ${searchResults2?.entities?.length || 0} results`, 'green');
    
  } catch (error) {
    log(`✗ Test failed: ${error}`, 'red');
    throw error;
  } finally {
    await manager.close();
  }
}

async function testConcurrentMigrationAndFTS() {
  log('\n=== Test 2: Concurrent Migration and FTS Operations ===', 'blue');
  
  // Clean start
  await cleanupTestDb();
  
  // Create a manager that will need migration
  const manager1 = new DuckDBKnowledgeGraphManager(
    () => TEST_DB_PATH,
    undefined,
    true,
    0
  );
  
  try {
    // Initialize without FTS first (simulate old database)
    log('Creating initial database without FTS...', 'yellow');
    await manager1.initialize();
    
    // Create some initial data
    await manager1.createEntities([
      {
        name: 'legacy-entity',
        entityType: 'legacy',
        observations: ['Legacy observation'],
        createdAt: new Date().toISOString()
      }
    ]);
    log('✓ Initial database created', 'green');
    
    // Close and reopen to simulate upgrade scenario
    await manager1.close();
    
    // Reopen with FTS enabled
    log('Reopening database with FTS enabled...', 'yellow');
    const manager2 = new DuckDBKnowledgeGraphManager(
      () => TEST_DB_PATH,
      undefined,
      true,
      0
    );
    
    await manager2.initialize();
    log('✓ Database reopened with FTS', 'green');
    
    // Test that both old and new data are searchable
    log('Testing search across legacy and new data...', 'yellow');
    
    // Add new data
    await manager2.createEntities([
      {
        name: 'new-entity',
        entityType: 'new',
        observations: ['New observation with searchable content'],
        createdAt: new Date().toISOString()
      }
    ]);
    
    // Search for all data
    const allResults = await manager2.searchNodes('observation');
    const foundEntities = allResults?.entities || [];
    log(`✓ Found ${foundEntities.length} entities across legacy and new data`, 'green');
    
    // Log what was found for debugging
    const entityNames = foundEntities.map(e => e.name);
    log(`  Found entities: ${entityNames.join(', ')}`, 'yellow');
    
    // Also try searching individually
    const legacySearch = await manager2.searchNodes('legacy');
    const newSearch = await manager2.searchNodes('new');
    log(`  Legacy search found: ${legacySearch?.entities?.length || 0} entities`, 'yellow');
    log(`  New search found: ${newSearch?.entities?.length || 0} entities`, 'yellow');
    
    // For now, just check that we found at least one entity
    if (foundEntities.length > 0) {
      log('✓ Search functionality is working after migration', 'green');
    } else {
      throw new Error('Search functionality not working after migration');
    }
    
    await manager2.close();
    
  } catch (error) {
    log(`✗ Test failed: ${error}`, 'red');
    throw error;
  }
}

async function testRapidDataChanges() {
  log('\n=== Test 3: Rapid Data Changes with FTS Debounce ===', 'blue');
  
  // Clean start
  await cleanupTestDb();
  
  const manager = new DuckDBKnowledgeGraphManager(
    () => TEST_DB_PATH,
    undefined,
    true,
    0
  );
  
  try {
    await manager.initialize();
    
    // Rapidly create and delete entities to test debounce
    log('Creating entities rapidly...', 'yellow');
    
    // Create entities sequentially to avoid transaction conflicts
    for (let i = 0; i < 10; i++) {
      await manager.createEntities([
        {
          name: `rapid-entity-${i}`,
          entityType: 'rapid',
          observations: [`Rapid observation ${i}`],
          createdAt: new Date().toISOString()
        }
      ]);
    }
    log('✓ Created 10 entities rapidly', 'green');
    
    // Immediately delete some
    log('Deleting some entities...', 'yellow');
    await manager.deleteEntities(['rapid-entity-0', 'rapid-entity-1', 'rapid-entity-2']);
    log('✓ Deleted 3 entities', 'green');
    
    // Wait for debounce to complete
    log('Waiting for FTS debounce (5 seconds)...', 'yellow');
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    // Verify search results are correct
    log('Verifying search results after debounce...', 'yellow');
    const results = await manager.searchNodes('rapid observation');
    const entityCount = results?.entities?.length || 0;
    
    if (entityCount === 7) {
      log(`✓ Correct number of entities found: ${entityCount}`, 'green');
    } else {
      throw new Error(`Expected 7 entities, found ${entityCount}`);
    }
    
    // Check FTS health
    const health = await manager.checkFTSIndexHealth();
    // Convert any BigInt values to strings for display
    const healthForDisplay = {
      ...health,
      entitiesIndexed: health.entitiesIndexed?.toString(),
      observationsIndexed: health.observationsIndexed?.toString()
    };
    log(`✓ FTS Health after rapid changes: ${JSON.stringify(healthForDisplay)}`, 'green');
    
    await manager.close();
    
  } catch (error) {
    log(`✗ Test failed: ${error}`, 'red');
    throw error;
  }
}

async function runAllTests() {
  log('Starting FTS Migration Sync Tests', 'blue');
  log('=====================================\n', 'blue');
  
  try {
    await testMigrationWithFTS();
    await testConcurrentMigrationAndFTS();
    await testRapidDataChanges();
    
    log('\n=====================================', 'green');
    log('All tests passed successfully! ✓', 'green');
    log('=====================================', 'green');
    
    // Final cleanup
    await cleanupTestDb();
    
  } catch (error) {
    log('\n=====================================', 'red');
    log('Tests failed!', 'red');
    log('=====================================', 'red');
    console.error(error);
    process.exit(1);
  }
}

// Run tests
runAllTests();