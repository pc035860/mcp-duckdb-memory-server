import { Logger } from "../logger";
import { extractError } from "../utils";

/**
 * Operation types that require concurrency control
 */
export type OperationType = 'migration' | 'ftsRebuild' | 'deletion' | 'bulkWrite';

/**
 * Operation state tracking
 */
export interface OperationState {
  type: OperationType;
  inProgress: boolean;
  startTime?: number;
  promise?: Promise<any>;
}

/**
 * Queued operation
 */
interface QueuedOperation<T = any> {
  type: OperationType;
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  priority: number;
  enqueueTime: number;
}

/**
 * Concurrency controller for managing operation conflicts and serialization
 */
export class ConcurrencyController {
  private logger: Logger;
  private operationStates: Map<OperationType, OperationState> = new Map();
  private operationQueue: QueuedOperation[] = [];
  private processingQueue: boolean = false;
  private maxQueueSize: number;
  private operationTimeout: number;
  
  // Operation priorities (lower number = higher priority)
  private static readonly PRIORITIES: Record<OperationType, number> = {
    migration: 0,
    deletion: 1,
    bulkWrite: 2,
    ftsRebuild: 3,
  };
  
  // Operation conflicts matrix
  private static readonly CONFLICTS: Record<OperationType, OperationType[]> = {
    migration: ['ftsRebuild', 'deletion', 'bulkWrite'],
    deletion: ['migration', 'ftsRebuild'],
    bulkWrite: ['migration', 'ftsRebuild'],
    ftsRebuild: ['migration', 'deletion', 'bulkWrite'],
  };
  
  constructor(
    logger: Logger,
    maxQueueSize: number = 100,
    operationTimeout: number = 60000 // 60 seconds
  ) {
    this.logger = logger;
    this.maxQueueSize = maxQueueSize;
    this.operationTimeout = operationTimeout;
    
    // Initialize operation states
    for (const type of ['migration', 'deletion', 'bulkWrite', 'ftsRebuild'] as OperationType[]) {
      this.operationStates.set(type, {
        type,
        inProgress: false,
      });
    }
  }
  
  /**
   * Execute an operation with concurrency control
   */
  async execute<T>(
    type: OperationType,
    operation: () => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      // Check queue size
      if (this.operationQueue.length >= this.maxQueueSize) {
        reject(new Error(`Operation queue full (max: ${this.maxQueueSize})`));
        return;
      }
      
      // Add to queue with priority
      const queuedOp: QueuedOperation<T> = {
        type,
        operation,
        resolve,
        reject,
        priority: ConcurrencyController.PRIORITIES[type],
        enqueueTime: Date.now(),
      };
      
      this.operationQueue.push(queuedOp);
      this.logger.debug(`Operation ${type} enqueued, queue size: ${this.operationQueue.length}`);
      
      // Start processing if not already
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }
  
  /**
   * Process the operation queue
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.operationQueue.length === 0) {
      return;
    }
    
    this.processingQueue = true;
    this.logger.debug("Started processing operation queue");
    
    while (this.operationQueue.length > 0) {
      // Sort queue by priority and enqueue time
      this.operationQueue.sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.enqueueTime - b.enqueueTime;
      });
      
      const item = this.operationQueue.shift()!;
      const waitTime = Date.now() - item.enqueueTime;
      
      // Check if operation has been waiting too long
      if (waitTime > this.operationTimeout) {
        item.reject(new Error(`Operation ${item.type} timed out after ${waitTime}ms`));
        this.logger.error(`Operation ${item.type} timed out in queue`);
        continue;
      }
      
      try {
        // Wait for conflicting operations
        await this.waitForConflicts(item.type);
        
        // Mark operation as in progress
        const state = this.operationStates.get(item.type)!;
        state.inProgress = true;
        state.startTime = Date.now();
        
        // Create a timeout wrapper for the operation
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Operation ${item.type} execution timeout`));
          }, this.operationTimeout);
        });
        
        // Execute operation with timeout
        const operationPromise = item.operation();
        state.promise = operationPromise;
        
        const result = await Promise.race([operationPromise, timeoutPromise]);
        
        // Calculate execution time before clearing state
        const executionTime = Date.now() - state.startTime!;
        
        // Clear operation state
        state.inProgress = false;
        state.promise = undefined;
        state.startTime = undefined;
        
        item.resolve(result);
        
        this.logger.info(`Operation ${item.type} completed in ${executionTime}ms`);
        
      } catch (error) {
        // Clear operation state on error
        const state = this.operationStates.get(item.type)!;
        state.inProgress = false;
        state.promise = undefined;
        state.startTime = undefined;
        
        item.reject(error);
        this.logger.error(`Operation ${item.type} failed`, extractError(error));
      }
    }
    
    this.processingQueue = false;
    this.logger.debug("Finished processing operation queue");
  }
  
  /**
   * Wait for conflicting operations to complete
   */
  private async waitForConflicts(operationType: OperationType): Promise<void> {
    const conflicts = ConcurrencyController.CONFLICTS[operationType] || [];
    
    for (const conflictType of conflicts) {
      const conflictState = this.operationStates.get(conflictType);
      
      if (conflictState?.inProgress && conflictState.promise) {
        this.logger.debug(
          `Operation ${operationType} waiting for ${conflictType} to complete`
        );
        
        try {
          await conflictState.promise;
        } catch (error) {
          // Ignore errors from conflicting operations
          this.logger.debug(
            `Conflicting operation ${conflictType} failed, continuing with ${operationType}`
          );
        }
      }
    }
  }
  
  /**
   * Get current operation status
   */
  getStatus(): {
    states: Record<OperationType, boolean>;
    queueLength: number;
    processingQueue: boolean;
  } {
    // Initialize with all operation types set to false
    const states: Record<OperationType, boolean> = {
      migration: false,
      ftsRebuild: false,
      deletion: false,
      bulkWrite: false
    };
    
    // Update with actual states
    for (const [type, state] of this.operationStates) {
      states[type] = state.inProgress;
    }
    
    return {
      states,
      queueLength: this.operationQueue.length,
      processingQueue: this.processingQueue,
    };
  }
  
  /**
   * Check if a specific operation type is in progress
   */
  isOperationInProgress(type: OperationType): boolean {
    return this.operationStates.get(type)?.inProgress || false;
  }
  
  /**
   * Clear the operation queue
   */
  clearQueue(): void {
    for (const item of this.operationQueue) {
      item.reject(new Error("Operation queue cleared"));
    }
    this.operationQueue = [];
    this.logger.info("Operation queue cleared");
  }
  
  /**
   * Get queue statistics
   */
  getQueueStats(): {
    queueSize: number;
    operationCounts: Record<OperationType, number>;
    oldestWaitTime: number | null;
  } {
    const operationCounts: Record<OperationType, number> = {
      migration: 0,
      deletion: 0,
      bulkWrite: 0,
      ftsRebuild: 0,
    };
    
    for (const item of this.operationQueue) {
      operationCounts[item.type]++;
    }
    
    const oldestWaitTime = this.operationQueue.length > 0
      ? Date.now() - Math.min(...this.operationQueue.map(op => op.enqueueTime))
      : null;
    
    return {
      queueSize: this.operationQueue.length,
      operationCounts,
      oldestWaitTime,
    };
  }
}