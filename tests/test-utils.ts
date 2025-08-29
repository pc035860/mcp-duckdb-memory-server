import { join } from "path";
import { existsSync, unlinkSync, readdirSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { DuckDBKnowledgeGraphManager } from "../src/managers/duckdb-manager.js";

/**
 * Generate a unique database path for testing
 */
export function generateUniqueDbPath(prefix: string = "test"): string {
  const testId = Math.random().toString(36).substring(7);
  const timestamp = Date.now();
  return join(process.cwd(), "tmp", `${prefix}-${timestamp}-${testId}.db`);
}

/**
 * Generate a unique temporary directory for test databases
 */
export function generateUniqueTempDir(prefix: string = "test"): string {
  const testId = randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const dir = join(tmpdir(), `${prefix}-${timestamp}-${testId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up test database files safely
 */
export async function cleanupTestDb(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) return;
  
  try {
    // Ensure database is fully closed first
    await ensureDbFullyClosed(dbPath);
    
    unlinkSync(dbPath);
    
    // Also clean up WAL files if they exist
    const walPath = `${dbPath}.wal`;
    if (existsSync(walPath)) {
      try {
        unlinkSync(walPath);
      } catch (error) {
        // WAL file might be locked, ignore
      }
    }
  } catch (error) {
    // File might be locked, try again after a short delay
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      unlinkSync(dbPath);
    } catch (retryError) {
      console.warn(`Failed to cleanup test database: ${dbPath}`, retryError);
    }
  }
}

/**
 * Clean up temporary directory recursively
 */
export async function cleanupTempDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) return;
  
  try {
    const fs = await import('fs');
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (error) {
    // Retry once after a delay
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      const fs = await import('fs');
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (retryError) {
      console.warn(`Failed to cleanup temp directory: ${dirPath}`, retryError);
    }
  }
}

/**
 * Clean up all test files in tmp directory
 */
export async function cleanupAllTestFiles(): Promise<void> {
  const tmpDir = join(process.cwd(), "tmp");
  if (!existsSync(tmpDir)) return;
  
  try {
    const files = readdirSync(tmpDir);
    for (const file of files) {
      if (file.startsWith('test-')) {
        await cleanupTestDb(join(tmpDir, file));
      }
    }
  } catch (error) {
    console.warn('Failed to cleanup test files:', error);
  }
}

/**
 * Safe manager close with proper error handling
 */
export async function safeCloseManager(manager: any): Promise<void> {
  if (!manager || manager.isClosed) return;
  
  try {
    // Wait for any pending operations
    await new Promise(resolve => setTimeout(resolve, 50));
    await manager.close();
    
    // Additional wait to ensure full cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
  } catch (error) {
    console.warn('Failed to close manager:', error);
    // Don't throw, just warn
  }
}

/**
 * Wait for a condition to be true or timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await condition();
      if (result) return true;
    } catch (error) {
      // Ignore errors and continue waiting
    }
    
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  return false;
}

/**
 * Create a test database in isolation to avoid CLI locking issues
 */
export async function createDatabaseViaCLI(
  dbPath: string,
  entities: Array<{
    name: string;
    entityType: string;
    observations: string[];
    createdAt: string;
  }>,
  relations: Array<{
    from: string;
    to: string;
    relationType: string;
    createdAt: string;
  }> = []
): Promise<void> {
  // Ensure directory exists
  const dir = join(dbPath, '..');
  mkdirSync(dir, { recursive: true });
  
  // Create database in an isolated function scope
  await (async () => {
    const manager = new DuckDBKnowledgeGraphManager(() => dbPath, undefined, true);
    
    try {
      await manager.initialize();
      
      // Add entities
      if (entities.length > 0) {
        await manager.createEntities(entities);
      }
      
      // Add relations
      if (relations.length > 0) {
        await manager.createRelations(relations);
      }
    } finally {
      await manager.close();
      // Additional wait to ensure complete cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  
  // Ensure database is fully closed
  await ensureDbFullyClosed(dbPath);
}

/**
 * Wait for file locks to be released
 */
export async function waitForFileUnlock(filePath: string, timeoutMs: number = 5000): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Try to access the file to check if it's unlocked
      const fs = await import('fs');
      const fd = fs.openSync(filePath, 'r+');
      fs.closeSync(fd);
      return; // File is unlocked
    } catch (error) {
      // File is still locked, wait
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  throw new Error(`File ${filePath} remained locked after ${timeoutMs}ms`);
}

/**
 * Ensure all database connections are fully closed and WAL files are flushed
 */
export async function ensureDbFullyClosed(dbPath: string): Promise<void> {
  // Wait for any pending operations
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Try to open and close the database to ensure it's in a clean state
  try {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();
    
    // Force a checkpoint to flush WAL
    try {
      await conn.run('CHECKPOINT');
    } catch (e) {
      // Ignore checkpoint errors
    }
    
    try { (conn as any).disconnect?.(); } catch {}
    
    // Wait for final cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
  } catch (error) {
    // Database might not exist or be locked, that's ok
  }
}