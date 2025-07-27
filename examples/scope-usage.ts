/**
 * Example: Using scope filter with searchMultiKeywords
 * 
 * This example demonstrates how to use the new scope parameter
 * to filter search results by project or namespace.
 */

import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';

async function demonstrateScopeUsage() {
  const manager = new DuckDBKnowledgeGraphManager(() => './example-scope.db');
  await manager.initialize();

  try {
    // Create entities with different project scopes
    await manager.createEntities([
      // Project A entities
      {
        name: 'projectA:user_service',
        entityType: 'service',
        observations: ['Handles user authentication', 'JWT-based auth'],
        createdAt: new Date().toISOString()
      },
      {
        name: '[projectA]:payment_service',
        entityType: 'service',
        observations: ['Stripe integration', 'Payment processing'],
        createdAt: new Date().toISOString()
      },
      {
        name: 'projectA:database_config',
        entityType: 'config',
        observations: ['PostgreSQL configuration', 'Connection pooling'],
        createdAt: new Date().toISOString()
      },
      // Project B entities
      {
        name: 'projectB:user_service',
        entityType: 'service',
        observations: ['OAuth2 authentication', 'Social login support'],
        createdAt: new Date().toISOString()
      },
      {
        name: '[projectB]:notification_service',
        entityType: 'service',
        observations: ['Email notifications', 'Push notifications'],
        createdAt: new Date().toISOString()
      },
      // Global entities (no project scope)
      {
        name: 'global_logger',
        entityType: 'utility',
        observations: ['Centralized logging', 'Log aggregation'],
        createdAt: new Date().toISOString()
      }
    ]);

    console.log('🎯 Scope Usage Examples\n');

    // Example 1: Search without scope (returns all matches)
    console.log('1. Search for "service" without scope:');
    const allServices = await manager.searchMultiKeywords(['service']);
    console.log(`   Found ${allServices.entities.length} entities:`);
    allServices.entities.forEach(e => console.log(`   - ${e.name}`));

    // Example 2: Search with specific project scope
    console.log('\n2. Search for "service" in projectA scope:');
    const projectAServices = await manager.searchMultiKeywords(['service'], { 
      scope: 'projectA' 
    });
    console.log(`   Found ${projectAServices.entities.length} entities:`);
    projectAServices.entities.forEach(e => console.log(`   - ${e.name}`));

    // Example 3: Bracket notation works the same way
    console.log('\n3. Search for "service" using bracket notation [projectA]:');
    const bracketServices = await manager.searchMultiKeywords(['service'], { 
      scope: '[projectA]' 
    });
    console.log(`   Found ${bracketServices.entities.length} entities:`);
    bracketServices.entities.forEach(e => console.log(`   - ${e.name}`));

    // Example 4: Multi-keyword search with AND mode and scope
    console.log('\n4. Search for "user" AND "authentication" in projectA:');
    const authServices = await manager.searchMultiKeywords(['user', 'authentication'], { 
      scope: 'projectA',
      mode: 'AND'
    });
    console.log(`   Found ${authServices.entities.length} entities:`);
    authServices.entities.forEach(e => console.log(`   - ${e.name}: ${e.observations.join(', ')}`));

    // Example 5: OR mode with scope
    console.log('\n5. Search for "email" OR "push" in projectB:');
    const notificationServices = await manager.searchMultiKeywords(['email', 'push'], { 
      scope: 'projectB',
      mode: 'OR'
    });
    console.log(`   Found ${notificationServices.entities.length} entities:`);
    notificationServices.entities.forEach(e => console.log(`   - ${e.name}: ${e.observations.join(', ')}`));

    // Example 6: Search in non-existent scope
    console.log('\n6. Search in non-existent scope:');
    const noResults = await manager.searchMultiKeywords(['service'], { 
      scope: 'projectC' 
    });
    console.log(`   Found ${noResults.entities.length} entities (expected: 0)`);

    // Example 7: Compare with searchNodes scope behavior
    console.log('\n7. Consistency check - searchNodes vs searchMultiKeywords:');
    const searchNodesResult = await manager.searchNodes('service', { scope: 'projectA' });
    const multiKeywordResult = await manager.searchMultiKeywords(['service'], { scope: 'projectA' });
    console.log(`   searchNodes found: ${searchNodesResult.entities.length} entities`);
    console.log(`   searchMultiKeywords found: ${multiKeywordResult.entities.length} entities`);
    console.log(`   Results are ${searchNodesResult.entities.length === multiKeywordResult.entities.length ? '✅ consistent' : '❌ inconsistent'}`);

  } finally {
    await manager.close();
  }
}

// Run the demonstration
demonstrateScopeUsage()
  .then(() => console.log('\n✨ Scope demonstration completed!'))
  .catch(error => console.error('Error:', error));