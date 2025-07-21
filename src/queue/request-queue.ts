import { Logger } from "../logger";
import { extractError } from "../utils";

/**
 * Request queue item
 */
interface QueueItem<T = any> {
  id: string;
  request: T;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  startTime: number;
}

/**
 * Request queue for serializing database operations
 */
export class RequestQueue<T = any> {
  private queue: QueueItem<T>[] = [];
  private processing: boolean = false;
  private maxSize: number;
  private timeoutMs: number;
  private logger: Logger;
  private requestHandler: (request: T) => Promise<any>;

  constructor(
    requestHandler: (request: T) => Promise<any>,
    maxSize: number = 100,
    timeoutMs: number = 30000,
    logger: Logger
  ) {
    this.requestHandler = requestHandler;
    this.maxSize = maxSize;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  /**
   * Add request to queue
   */
  async enqueue(id: string, request: T): Promise<any> {
    return new Promise((resolve, reject) => {
      // Check queue size
      if (this.queue.length >= this.maxSize) {
        reject(new Error("Request queue is full"));
        return;
      }

      // Create timeout
      const timeout = setTimeout(() => {
        this.removeFromQueue(id);
        reject(new Error(`Request timeout: ${id}`));
      }, this.timeoutMs);

      // Add to queue
      const queueItem: QueueItem<T> = {
        id,
        request,
        resolve,
        reject,
        timeout,
        startTime: Date.now(),
      };

      this.queue.push(queueItem);
      this.logger.info("Request enqueued", { 
        id, 
        queueSize: this.queue.length,
        processing: this.processing 
      });

      // Start processing if not already processing
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process queue items sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    this.logger.info("Started processing request queue");

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      
      try {
        const startTime = Date.now();
        this.logger.info("Processing request", { 
          id: item.id,
          waitTime: startTime - item.startTime 
        });

        const result = await this.requestHandler(item.request);
        
        // Clear timeout and resolve
        clearTimeout(item.timeout);
        item.resolve(result);

        const endTime = Date.now();
        this.logger.info("Request completed", { 
          id: item.id,
          processingTime: endTime - startTime,
          totalTime: endTime - item.startTime
        });

      } catch (error) {
        // Clear timeout and reject
        clearTimeout(item.timeout);
        item.reject(error instanceof Error ? error : new Error(String(error)));

        this.logger.error("Request failed", { 
          id: item.id,
          error: extractError(error)
        });
      }
    }

    this.processing = false;
    this.logger.info("Finished processing request queue");
  }

  /**
   * Remove item from queue by ID
   */
  private removeFromQueue(id: string): void {
    const index = this.queue.findIndex(item => item.id === id);
    if (index !== -1) {
      const item = this.queue.splice(index, 1)[0];
      clearTimeout(item.timeout);
      this.logger.info("Request removed from queue", { id });
    }
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    queueSize: number;
    processing: boolean;
    maxSize: number;
    timeoutMs: number;
  } {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      maxSize: this.maxSize,
      timeoutMs: this.timeoutMs,
    };
  }

  /**
   * Clear all pending requests
   */
  clear(): void {
    for (const item of this.queue) {
      clearTimeout(item.timeout);
      item.reject(new Error("Queue cleared"));
    }
    this.queue = [];
    this.processing = false;
    this.logger.info("Request queue cleared");
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is processing
   */
  isProcessing(): boolean {
    return this.processing;
  }
}