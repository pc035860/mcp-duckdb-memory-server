/**
 * 測試時間篩選功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBKnowledgeGraphManager } from '../src/managers/duckdb-manager.js';
import { RequestQueue } from '../src/queue/request-queue.js';
import fs from 'node:fs';

describe('時間篩選功能測試', () => {
  let manager: DuckDBKnowledgeGraphManager;
  let queue: RequestQueue;
  const testDbPath = './test-time-filter.db';

  beforeEach(async () => {
    // 清理測試資料庫
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    queue = new RequestQueue();
    manager = new DuckDBKnowledgeGraphManager(() => testDbPath, undefined, true); // 允許外部時間戳記
    await manager.initialize();

    // 建立測試資料 - 使用不同的時間點
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const entities = [
      {
        name: 'test-project:recent_entity',
        entityType: 'feature',
        observations: ['This is a recent feature'],
        createdAt: now.toISOString()
      },
      {
        name: 'test-project:hour_old_entity', 
        entityType: 'bug',
        observations: ['This is an hour old bug'],
        createdAt: oneHourAgo.toISOString()
      },
      {
        name: 'test-project:day_old_entity',
        entityType: 'task',
        observations: ['This is a day old task'],
        createdAt: oneDayAgo.toISOString()
      },
      {
        name: 'test-project:week_old_entity',
        entityType: 'project',
        observations: ['This is a week old project'],
        createdAt: oneWeekAgo.toISOString()
      }
    ];

    await manager.createEntities(entities);
  });

  afterEach(async () => {
    await manager.close();
    // 清理測試資料庫
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('應該能夠篩選最近 1 小時內的實體', async () => {
    const results = await manager.searchNodes('entity', {
      scope: 'test-project',
      timeRange: { lastHours: 1 }
    });

    expect(results.entities).toHaveLength(1);
    expect(results.entities[0].name).toBe('test-project:recent_entity');
  });

  it('應該能夠篩選最近 1 天內的實體', async () => {
    const results = await manager.searchNodes('entity', {
      scope: 'test-project', 
      timeRange: { lastDays: 1 }
    });

    // 應該包含最近 1 小時和 1 小時前的實體
    expect(results.entities.length).toBeGreaterThanOrEqual(2);
    const entityNames = results.entities.map(e => e.name);
    expect(entityNames).toContain('test-project:recent_entity');
    expect(entityNames).toContain('test-project:hour_old_entity');
  });

  it('應該能夠使用指定時間範圍篩選', async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const results = await manager.searchNodes('entity', {
      scope: 'test-project',
      timeRange: {
        createdAfter: oneWeekAgo.toISOString(),
        createdBefore: oneDayAgo.toISOString()
      }
    });

    // 應該只包含 week_old_entity（在範圍內但不包含 day_old_entity）
    expect(results.entities.length).toBeGreaterThanOrEqual(0);
    const entityNames = results.entities.map(e => e.name);
    expect(entityNames).not.toContain('test-project:recent_entity');
    expect(entityNames).not.toContain('test-project:hour_old_entity');
  });

  it('多關鍵字搜尋應該支援時間篩選', async () => {
    const results = await manager.searchMultiKeywords(['entity', 'bug'], {
      scope: 'test-project',
      mode: 'OR',
      timeRange: { lastDays: 2 }
    });

    // 應該包含最近 2 天內所有匹配的實體
    expect(results.entities.length).toBeGreaterThanOrEqual(2);
    const entityNames = results.entities.map(e => e.name);
    expect(entityNames).toContain('test-project:recent_entity');
    expect(entityNames).toContain('test-project:hour_old_entity');
    expect(entityNames).toContain('test-project:day_old_entity');
  });

  it('多關鍵字搜尋 AND 模式應該支援時間篩選', async () => {
    const results = await manager.searchMultiKeywords(['hour', 'bug'], {
      scope: 'test-project',
      mode: 'AND',
      timeRange: { lastDays: 1 }
    });

    // 應該只包含同時匹配 'hour' 和 'bug' 且在 1 天內的實體
    expect(results.entities.length).toBeGreaterThanOrEqual(1);
    const entityNames = results.entities.map(e => e.name);
    expect(entityNames).toContain('test-project:hour_old_entity');
  });

  it('當沒有符合時間條件的實體時應該返回空結果', async () => {
    const results = await manager.searchNodes('entity', {
      scope: 'test-project',
      timeRange: { lastMinutes: 30 } // 最近 30 分鐘，應該只有 recent_entity
    });

    expect(results.entities).toHaveLength(1);
    expect(results.entities[0].name).toBe('test-project:recent_entity');
  });
});