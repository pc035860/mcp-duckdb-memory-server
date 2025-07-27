import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager';
import { existsSync, unlinkSync } from "fs";
import { join } from 'path';
import type { Entity } from '../src/types';

describe('searchMultiKeywords with scope', () => {
  let manager: DuckDBKnowledgeGraphManager;
  let testDbPath: string;
  
  beforeEach(async () => {
    // Generate unique test database path for each test
    const testId = Math.random().toString(36).substring(7);
    testDbPath = join(process.cwd(), 'tmp', `test-search-scope-${testId}.db`);
    
    // Create test manager
    manager = new DuckDBKnowledgeGraphManager(() => testDbPath);
    await manager.initialize();
    
    // Create test entities with different scopes
    const entities: Entity[] = [
      {
        name: 'myproject:auth_service',
        entityType: 'service',
        observations: ['Handles authentication', 'JWT tokens'],
        createdAt: new Date().toISOString()
      },
      {
        name: '[myproject]:payment_service',
        entityType: 'service', 
        observations: ['Payment processing', 'Stripe integration'],
        createdAt: new Date().toISOString()
      },
      {
        name: 'otherproject:auth_service',
        entityType: 'service',
        observations: ['Different auth service', 'OAuth support'],
        createdAt: new Date().toISOString()
      },
      {
        name: 'global_logger',
        entityType: 'utility',
        observations: ['Global logging utility'],
        createdAt: new Date().toISOString()
      }
    ];
    
    await manager.createEntities(entities);
  });
  
  afterEach(async () => {
    await manager.close();
    // Cleanup test database
    [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`].forEach((file) => {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {}
      }
    });
  });
  
  it('should return all matching entities when no scope is provided', async () => {
    const result = await manager.searchMultiKeywords(['service']);
    expect(result.entities).toHaveLength(3);
    const names = result.entities.map(e => e.name).sort();
    expect(names).toEqual([
      '[myproject]:payment_service',
      'myproject:auth_service',
      'otherproject:auth_service'
    ]);
  });
  
  it('should filter by scope when provided', async () => {
    const result = await manager.searchMultiKeywords(['service'], { scope: 'myproject' });
    expect(result.entities).toHaveLength(2);
    const names = result.entities.map(e => e.name).sort();
    expect(names).toEqual([
      '[myproject]:payment_service',
      'myproject:auth_service'
    ]);
  });
  
  it('should handle bracket notation in scope', async () => {
    const result = await manager.searchMultiKeywords(['service'], { scope: '[myproject]' });
    expect(result.entities).toHaveLength(2);
    const names = result.entities.map(e => e.name).sort();
    expect(names).toEqual([
      '[myproject]:payment_service',
      'myproject:auth_service'
    ]);
  });
  
  it('should work with AND mode and scope', async () => {
    const result = await manager.searchMultiKeywords(['service', 'auth'], { 
      scope: 'myproject',
      mode: 'AND' 
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('myproject:auth_service');
  });
  
  it('should return empty results for non-matching scope', async () => {
    const result = await manager.searchMultiKeywords(['service'], { scope: 'nonexistent' });
    expect(result.entities).toHaveLength(0);
  });
  
  it('should work with scope in OR mode', async () => {
    const result = await manager.searchMultiKeywords(['auth', 'payment'], {
      scope: 'myproject',
      mode: 'OR'
    });
    expect(result.entities).toHaveLength(2);
    const names = result.entities.map(e => e.name).sort();
    expect(names).toEqual([
      '[myproject]:payment_service',
      'myproject:auth_service'
    ]);
  });

  it('should be consistent with searchNodes scope behavior', async () => {
    // Test that both methods return the same results with scope
    const multiKeywordResult = await manager.searchMultiKeywords(['service'], { scope: 'myproject' });
    const searchNodesResult = await manager.searchNodes('service', { scope: 'myproject' });
    
    const multiNames = multiKeywordResult.entities.map(e => e.name).sort();
    const searchNames = searchNodesResult.entities.map(e => e.name).sort();
    
    expect(multiNames).toEqual(searchNames);
  });
});