import type { 
  IEmbeddingCache, 
  EmbeddingVector, 
  EmbeddingCacheStats 
} from '../../types/embedding.js';
import { logger } from '../../logger.js';

interface CacheNode {
  key: string;
  value: EmbeddingVector;
  prev: CacheNode | null;
  next: CacheNode | null;
  timestamp: number;
}

export class EmbeddingLRUCache implements IEmbeddingCache {
  private cache = new Map<string, CacheNode>();
  private head: CacheNode;
  private tail: CacheNode;
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
    
    // 初始化雙向鏈表的哨兵節點
    this.head = { key: '', value: [], prev: null, next: null, timestamp: 0 };
    this.tail = { key: '', value: [], prev: null, next: null, timestamp: 0 };
    this.head.next = this.tail;
    this.tail.prev = this.head;

    logger.info('Embedding LRU Cache initialized', { maxSize });
  }

  async get(key: string): Promise<EmbeddingVector | null> {
    const node = this.cache.get(key);
    
    if (!node) {
      this.misses++;
      logger.debug('Cache miss', { key: key.slice(0, 20) + '...' });
      return null;
    }

    // 移動到頭部（最近使用）
    this.moveToHead(node);
    this.hits++;
    
    logger.debug('Cache hit', { 
      key: key.slice(0, 20) + '...',
      vectorDimension: node.value.length,
      hitRate: this.getHitRate()
    });
    
    return node.value;
  }

  async set(key: string, embedding: EmbeddingVector): Promise<void> {
    const existingNode = this.cache.get(key);
    
    if (existingNode) {
      // 更新現有節點
      existingNode.value = embedding;
      existingNode.timestamp = Date.now();
      this.moveToHead(existingNode);
    } else {
      // 創建新節點
      const newNode: CacheNode = {
        key,
        value: embedding,
        prev: null,
        next: null,
        timestamp: Date.now(),
      };

      this.cache.set(key, newNode);
      this.addToHead(newNode);

      // 如果超過容量，移除尾部節點
      if (this.cache.size > this.maxSize) {
        const tail = this.removeTail();
        if (tail) {
          this.cache.delete(tail.key);
        }
      }
    }

    logger.debug('Cache set', { 
      key: key.slice(0, 20) + '...',
      cacheSize: this.cache.size,
      maxSize: this.maxSize
    });
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.hits = 0;
    this.misses = 0;
    
    logger.info('Embedding cache cleared');
  }

  async getStats(): Promise<EmbeddingCacheStats> {
    const stats: EmbeddingCacheStats = {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRate: this.getHitRate(),
    };

    logger.debug('Cache stats requested', stats);
    return stats;
  }

  // 獲取快取中最舊的項目（用於調試和監控）
  getOldestEntry(): { key: string; age: number } | null {
    if (this.tail.prev === this.head) {
      return null;
    }
    
    const oldestNode = this.tail.prev!;
    const age = Date.now() - oldestNode.timestamp;
    
    return {
      key: oldestNode.key,
      age,
    };
  }

  // 獲取快取使用情況
  getCacheUtilization(): number {
    return this.cache.size / this.maxSize;
  }

  private moveToHead(node: CacheNode): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  private removeNode(node: CacheNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
  }

  private addToHead(node: CacheNode): void {
    node.prev = this.head;
    node.next = this.head.next;

    if (this.head.next) {
      this.head.next.prev = node;
    }
    this.head.next = node;
  }

  private removeTail(): CacheNode | null {
    const lastNode = this.tail.prev;
    if (lastNode === this.head) {
      return null;
    }
    
    this.removeNode(lastNode!);
    return lastNode;
  }

  private getHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}

// 內存快取工廠函數
export function createEmbeddingCache(maxSize?: number): IEmbeddingCache {
  return new EmbeddingLRUCache(maxSize);
}