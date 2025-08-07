#!/usr/bin/env tsx

/**
 * Integration test for MCP DuckDB Memory Server
 * Tests basic functionality to ensure the FTS migration fix doesn't break core features
 */

import { DuckDBKnowledgeGraphManager } from '../../src/managers/duckdb-manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB_PATH = path.join(__dirname, 'test-integration.db');

// Enable debug logging
process.env.DEBUG = '1';

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
  } catch (error) {
    // File might not exist
  }
}

async function runIntegrationTest() {
  log('\n=== MCP DuckDB Memory Server Integration Test ===', 'blue');
  
  await cleanupTestDb();
  
  const manager = new DuckDBKnowledgeGraphManager(
    () => TEST_DB_PATH,
    undefined,
    true,
    1000 // Use default threshold
  );
  
  try {
    // 1. Initialize
    log('\n1. Initializing manager...', 'yellow');
    await manager.initialize();
    log('✓ Manager initialized', 'green');
    
    // 2. Create entities
    log('\n2. Creating entities...', 'yellow');
    const entities = await manager.createEntities([
      {
        name: 'project:auth-system',
        entityType: 'module',
        observations: ['Handles user authentication', 'Uses JWT tokens'],
        createdAt: new Date().toISOString()
      },
      {
        name: 'project:database-layer',
        entityType: 'module',
        observations: ['PostgreSQL connection', 'Connection pooling enabled'],
        createdAt: new Date().toISOString()
      }
    ]);
    log(`✓ Created ${entities.length} entities`, 'green');
    
    // 3. Create relations
    log('\n3. Creating relations...', 'yellow');
    const relations = await manager.createRelations([
      {
        from: 'project:auth-system',
        to: 'project:database-layer',
        relationType: 'depends_on'
      }
    ]);
    log(`✓ Created ${relations.length} relations`, 'green');
    
    // 4. Add observations
    log('\n4. Adding observations...', 'yellow');
    await manager.addObservations([
      {
        entityName: 'project:auth-system',
        contents: ['Added refresh token support']
      }
    ]);
    log('✓ Added observations', 'green');
    
    // 5. Search nodes (test both LIKE and FTS paths)
    log('\n5. Testing search functionality...', 'yellow');
    
    // Test LIKE search (will be used since entity count < threshold)
    const searchResult1 = await manager.searchNodes('authentication');
    log(`  LIKE search for "authentication": ${searchResult1.entities.length} results`, 'green');
    
    // Test with scope
    const searchResult2 = await manager.searchNodes('database', {
      scope: 'project'
    });
    log(`  Scoped search for "database": ${searchResult2.entities.length} results`, 'green');
    
    // 6. Open specific nodes
    log('\n6. Opening specific nodes...', 'yellow');
    const openResult = await manager.openNodes(['project:auth-system']);
    log(`  Opened node with ${openResult.entities[0]?.observations.length || 0} observations`, 'green');
    
    // 7. Read entire graph
    log('\n7. Reading entire graph...', 'yellow');
    const graph = await manager.readGraph();
    log(`  Graph contains ${graph.entities.length} entities and ${graph.relations.length} relations`, 'green');
    
    // 8. Delete operations
    log('\n8. Testing delete operations...', 'yellow');
    await manager.deleteObservations([
      {
        entityName: 'project:auth-system',
        contents: ['Added refresh token support']
      }
    ]);
    log('  ✓ Deleted observation', 'green');
    
    await manager.deleteRelations([
      {
        from: 'project:auth-system',
        to: 'project:database-layer',
        relationType: 'depends_on'
      }
    ]);
    log('  ✓ Deleted relation', 'green');
    
    await manager.deleteEntities(['project:database-layer']);
    log('  ✓ Deleted entity', 'green');
    
    // 9. Verify final state
    log('\n9. Verifying final state...', 'yellow');
    const finalGraph = await manager.readGraph();
    if (finalGraph.entities.length === 1 && 
        finalGraph.entities[0].name === 'project:auth-system' &&
        finalGraph.relations.length === 0) {
      log('✓ Final state is correct', 'green');
    } else {
      throw new Error('Final state is incorrect');
    }
    
    // 10. Test FTS health check
    log('\n10. Checking FTS health...', 'yellow');
    const health = await manager.checkFTSIndexHealth();
    log(`  FTS enabled: ${health.ftsEnabled}`, 'green');
    log(`  Status: ${health.status}`, 'green');
    
    log('\n' + '='.repeat(50), 'green');
    log('✅ All integration tests passed!', 'green');
    log('='.repeat(50), 'green');
    
  } catch (error) {
    log('\n' + '='.repeat(50), 'red');
    log('❌ Integration test failed!', 'red');
    log('='.repeat(50), 'red');
    console.error(error);
    throw error;
  } finally {
    await manager.close();
    await cleanupTestDb();
  }
}

// Run test
runIntegrationTest().catch(process.exit);