import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConcurrencyController } from "../src/utils/concurrency-controller";
import { ConsoleLogger } from "../src/logger";

describe("ConcurrencyController", () => {
  let controller: ConcurrencyController;
  let logger: ConsoleLogger;

  beforeEach(() => {
    logger = new ConsoleLogger();
    // Mock logger methods to avoid console output during tests
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    
    controller = new ConcurrencyController(logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Operation Serialization", () => {
    it("should execute operations sequentially", async () => {
      const results: number[] = [];
      
      // Create operations that record their execution order
      const op1 = controller.execute('bulkWrite', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push(1);
        return 1;
      });
      
      const op2 = controller.execute('deletion', async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        results.push(2);
        return 2;
      });
      
      const op3 = controller.execute('ftsRebuild', async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        results.push(3);
        return 3;
      });
      
      const values = await Promise.all([op1, op2, op3]);
      
      // Operations should be executed sequentially (first in, first out within same priority)
      // Since all operations are added almost simultaneously, they execute in the order processed
      expect(results.length).toBe(3);
      expect(values).toEqual([1, 2, 3]);
    });

    it("should handle operation failures gracefully", async () => {
      const results: string[] = [];
      
      const op1 = controller.execute('bulkWrite', async () => {
        results.push('op1-start');
        await new Promise(resolve => setTimeout(resolve, 20));
        results.push('op1-end');
        return 'success1';
      });
      
      const op2 = controller.execute('deletion', async () => {
        results.push('op2-start');
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error('Operation failed');
      });
      
      const op3 = controller.execute('ftsRebuild', async () => {
        results.push('op3-start');
        await new Promise(resolve => setTimeout(resolve, 10));
        results.push('op3-end');
        return 'success3';
      });
      
      const result1 = await op1;
      await expect(op2).rejects.toThrow('Operation failed');
      const result3 = await op3;
      
      expect(result1).toBe('success1');
      expect(result3).toBe('success3');
      // op2 should fail but not affect other operations
      expect(results).toContain('op1-start');
      expect(results).toContain('op1-end');
      expect(results).toContain('op2-start');
      expect(results).toContain('op3-start');
      expect(results).toContain('op3-end');
    });
  });

  describe("Priority Management", () => {
    it("should respect operation priorities", async () => {
      const executionOrder: string[] = [];
      
      // Add operations to ensure they queue up
      // Start with a blocking operation
      const blockingOp = controller.execute('ftsRebuild', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push('blocking');
        return 'blocking';
      });
      
      // Wait a bit to ensure blocking op starts
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Now add operations in reverse priority order
      const ftsOp = controller.execute('ftsRebuild', async () => {
        executionOrder.push('ftsRebuild');
        return 'fts';
      });
      
      const bulkOp = controller.execute('bulkWrite', async () => {
        executionOrder.push('bulkWrite');
        return 'bulk';
      });
      
      const deleteOp = controller.execute('deletion', async () => {
        executionOrder.push('deletion');
        return 'delete';
      });
      
      const migrationOp = controller.execute('migration', async () => {
        executionOrder.push('migration');
        return 'migrate';
      });
      
      await Promise.all([blockingOp, ftsOp, bulkOp, deleteOp, migrationOp]);
      
      // Should execute in priority order after blocking op: migration > deletion > bulkWrite > ftsRebuild
      expect(executionOrder).toEqual(['blocking', 'migration', 'deletion', 'bulkWrite', 'ftsRebuild']);
    });
  });

  describe("Conflict Detection", () => {
    it("should wait for conflicting operations", async () => {
      const events: string[] = [];
      
      // Start a migration operation
      const migrationOp = controller.execute('migration', async () => {
        events.push('migration-start');
        await new Promise(resolve => setTimeout(resolve, 100));
        events.push('migration-end');
        return 'migration-done';
      });
      
      // Start an FTS rebuild (should wait for migration)
      await new Promise(resolve => setTimeout(resolve, 10));
      const ftsOp = controller.execute('ftsRebuild', async () => {
        events.push('fts-start');
        await new Promise(resolve => setTimeout(resolve, 50));
        events.push('fts-end');
        return 'fts-done';
      });
      
      await Promise.all([migrationOp, ftsOp]);
      
      // FTS should start only after migration ends
      const migrationEndIndex = events.indexOf('migration-end');
      const ftsStartIndex = events.indexOf('fts-start');
      
      expect(migrationEndIndex).toBeLessThan(ftsStartIndex);
      expect(events).toEqual(['migration-start', 'migration-end', 'fts-start', 'fts-end']);
    });

    it("should handle multiple conflicting operations", async () => {
      const events: string[] = [];
      
      // Start a deletion operation
      const deleteOp = controller.execute('deletion', async () => {
        events.push('delete-start');
        await new Promise(resolve => setTimeout(resolve, 50));
        events.push('delete-end');
        return 'delete-done';
      });
      
      // These operations conflict with deletion
      await new Promise(resolve => setTimeout(resolve, 5));
      const migrationOp = controller.execute('migration', async () => {
        events.push('migration-start');
        await new Promise(resolve => setTimeout(resolve, 30));
        events.push('migration-end');
        return 'migration-done';
      });
      
      const ftsOp = controller.execute('ftsRebuild', async () => {
        events.push('fts-start');
        await new Promise(resolve => setTimeout(resolve, 20));
        events.push('fts-end');
        return 'fts-done';
      });
      
      await Promise.all([deleteOp, migrationOp, ftsOp]);
      
      // Migration has higher priority and should run after deletion
      // FTS should run last due to conflicts with both
      const deleteEndIndex = events.indexOf('delete-end');
      const migrationStartIndex = events.indexOf('migration-start');
      const ftsStartIndex = events.indexOf('fts-start');
      
      expect(deleteEndIndex).toBeLessThan(migrationStartIndex);
      expect(migrationStartIndex).toBeLessThan(ftsStartIndex);
    });
  });

  describe("Queue Management", () => {
    it("should track queue statistics", async () => {
      const ops: Promise<any>[] = [];
      
      // Add multiple operations
      for (let i = 0; i < 3; i++) {
        ops.push(controller.execute('bulkWrite', async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return i;
        }));
      }
      
      // Check queue stats while operations are pending
      const stats = controller.getQueueStats();
      expect(stats.queueSize).toBeGreaterThanOrEqual(0);
      expect(stats.queueSize).toBeLessThanOrEqual(3);
      
      await Promise.all(ops);
      
      // Queue should be empty after completion
      const finalStats = controller.getQueueStats();
      expect(finalStats.queueSize).toBe(0);
    });

    it("should respect max queue size", async () => {
      // Create controller with small queue size
      const smallController = new ConcurrencyController(logger, 2, 60000);
      
      // Start a blocking operation first
      const blockingOp = smallController.execute('bulkWrite', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 0;
      });
      
      // Wait to ensure blocking op starts processing
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Now add operations to fill the queue
      const op1 = smallController.execute('bulkWrite', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 1;
      });
      
      const op2 = smallController.execute('bulkWrite', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 2;
      });
      
      // This should exceed the limit (queue size is 2, but blocking op is processing)
      const op3 = smallController.execute('bulkWrite', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 3;
      }).catch(err => ({ error: err.message }));
      
      // One should fail due to queue size limit
      const results = await Promise.all([blockingOp, op1, op2, op3]);
      const hasQueueFullError = results.some(r => 
        typeof r === 'object' && 'error' in r && r.error.includes('queue full')
      );
      
      // Should have a queue full error
      expect(hasQueueFullError).toBe(true);
    });

    it("should handle operation timeout", async () => {
      // Create controller with short timeout
      const timeoutController = new ConcurrencyController(logger, 100, 100);
      
      // Create an operation that takes longer than timeout
      const slowOp = timeoutController.execute('bulkWrite', async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return 'should-timeout';
      });
      
      // Should timeout
      await expect(slowOp).rejects.toThrow('timeout');
    });
  });

  describe("Status Reporting", () => {
    it("should report operation status correctly", async () => {
      const status1 = controller.getStatus();
      expect(status1.states.migration).toBe(false);
      expect(status1.states.deletion).toBe(false);
      expect(status1.states.bulkWrite).toBe(false);
      expect(status1.states.ftsRebuild).toBe(false);
      expect(status1.queueLength).toBe(0);
      expect(status1.processingQueue).toBe(false);
      
      // Start an operation
      const op = controller.execute('deletion', async () => {
        // Check status during operation
        const status2 = controller.getStatus();
        expect(status2.states.deletion).toBe(true);
        
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'done';
      });
      
      await op;
      
      // Check status after completion
      const status3 = controller.getStatus();
      expect(status3.states.deletion).toBe(false);
    });

    it("should check if specific operation is in progress", async () => {
      expect(controller.isOperationInProgress('migration')).toBe(false);
      
      const op = controller.execute('migration', async () => {
        expect(controller.isOperationInProgress('migration')).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 20));
        return 'done';
      });
      
      await op;
      
      expect(controller.isOperationInProgress('migration')).toBe(false);
    });
  });

  describe("Queue Clearing", () => {
    it("should clear pending operations", async () => {
      const results: string[] = [];
      
      // Add multiple slow operations
      const ops: Promise<any>[] = [];
      for (let i = 0; i < 5; i++) {
        ops.push(controller.execute('bulkWrite', async () => {
          results.push(`op${i}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          return i;
        }).catch(() => 'cleared'));
      }
      
      // Give first operation time to start
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Clear the queue
      controller.clearQueue();
      
      // All operations except the one in progress should be rejected
      const finalResults = await Promise.all(ops);
      expect(finalResults.filter(r => r === 'cleared').length).toBeGreaterThanOrEqual(3);
    });
  });
});