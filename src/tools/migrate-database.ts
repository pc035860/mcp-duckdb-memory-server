#!/usr/bin/env node

import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { ConsoleLogger, LogLevel } from "../logger.js";
import { extractError } from "../utils.js";
import { existsSync, statSync, readFileSync } from "fs";
import { resolve, basename, dirname, join } from "path";
import { fileURLToPath } from "url";

interface EntityData {
  name: string;
  entityType: string;
  created_at: string;
}

interface ObservationData {
  entityName: string;
  content: string;
  created_at: string;
}

interface RelationData {
  from_entity: string;
  to_entity: string;
  relationType: string;
  created_at: string;
}

interface MigrationOptions {
  batchSize: number;
  verbose: boolean;
  skipValidation: boolean;
  skipErrors: boolean;
  maxRetries: number;
  retryDelayMs: number;
  filterPrefix?: string;
  dryRun: boolean;
  showProgress: boolean;
  compact: boolean;
  preserveTimestamps: boolean;
}

interface ProgressState {
  totalItems: number;
  processedItems: number;
  startTime: number;
  lastUpdateTime: number;
  lastUpdateCount: number;
  currentPhase: 'reading' | 'writing-entities' | 'writing-observations' | 'writing-relations' | 'verifying';
  itemsPerSecond: number;
  estimatedTimeRemaining: number;
}

interface MigrationReport {
  version: string;
  timestamp: string;
  duration: number;
  source: string;
  target: string;
  options: MigrationOptions;
  summary: {
    totalRead: number;
    totalWritten: number;
    totalSkipped: number;
    successRate: number;
  };
  details: {
    entities: {
      read: number;
      written: number;
      skipped: number;
      writeSpeed: number;
    };
    observations: {
      read: number;
      written: number;
      skipped: number;
      writeSpeed: number;
    };
    relations: {
      read: number;
      written: number;
      skipped: number;
      writeSpeed: number;
    };
  };
  performance: {
    avgItemsPerSecond: number;
    batchProcessingTimes: number[];
    memoryUsage: {
      peak: number;
      average: number;
    };
  };
  errorRecovery: {
    totalRetries: number;
    retriedBatches: number;
    partialBatches: number;
    recoveredItems: number;
    failedItems: FailedItem[];
  };
  warnings: string[];
  errors: string[];
  verification?: {
    entityCountMatch: boolean;
    observationCountMatch: boolean;
    relationCountMatch: boolean;
    orphanedObservations: number;
    invalidRelations: number;
  };
}

interface FailedItem {
  type: 'entity' | 'observation' | 'relation';
  index: number;
  data: any;
  error: string;
  retryCount: number;
  timestamp: string;
  batchIndex?: number;
  errorStack?: string;
}

class DatabaseMigrationTool {
  private logger: ConsoleLogger;
  private readonly MAX_FILE_SIZE_MB = 5000; // 5GB max file size
  private readonly DEFAULT_BATCH_SIZE = 1000;
  private readonly DEFAULT_MAX_RETRIES = 3;
  private readonly DEFAULT_RETRY_DELAY_MS = 1000;
  private readonly VERSION: string;
  private errorLogFile: string | null = null;
  private dryRunMode: boolean = false;
  private progressState: ProgressState = {
    totalItems: 0,
    processedItems: 0,
    startTime: 0,
    lastUpdateTime: 0,
    lastUpdateCount: 0,
    currentPhase: 'reading',
    itemsPerSecond: 0,
    estimatedTimeRemaining: 0,
  };
  private batchProcessingTimes: number[] = [];
  private memorySnapshots: number[] = [];
  private migrationStats = {
    entitiesRead: 0,
    entitiesWritten: 0,
    entitiesSkipped: 0,
    observationsRead: 0,
    observationsWritten: 0,
    observationsSkipped: 0,
    relationsRead: 0,
    relationsWritten: 0,
    relationsSkipped: 0,
    errors: [] as string[],
    warnings: [] as string[],
    failedItems: [] as FailedItem[],
    partialBatches: 0,
    retriedBatches: 0,
    totalRetries: 0,
    recoveredItems: 0,
    batchErrors: [] as { batchIndex: number; error: string; itemCount: number }[],
    startTime: 0,
    endTime: 0,
  };

  constructor() {
    this.logger = new ConsoleLogger();
    this.logger.setLevel(LogLevel.INFO);
    this.VERSION = this.getVersionFromPackageJson();
  }

  /**
   * Get version from package.json
   */
  private getVersionFromPackageJson(): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const packageJsonPath = join(__dirname, '..', '..', 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return packageJson.version || '1.0.0';
    } catch {
      return '1.0.0';
    }
  }

  /**
   * Update and display progress
   */
  private updateProgress(itemsProcessed: number, total: number, phase: typeof this.progressState.currentPhase): void {
    const now = Date.now();
    const timeSinceStart = now - this.progressState.startTime;
    const timeSinceLastUpdate = now - this.progressState.lastUpdateTime;
    
    // Update only if enough time has passed (avoid console spam)
    if (timeSinceLastUpdate < 500 && itemsProcessed < total) return;
    
    this.progressState.processedItems = itemsProcessed;
    this.progressState.totalItems = total;
    this.progressState.currentPhase = phase;
    
    // Calculate speed
    const itemsSinceLastUpdate = itemsProcessed - this.progressState.lastUpdateCount;
    if (timeSinceLastUpdate > 0) {
      this.progressState.itemsPerSecond = (itemsSinceLastUpdate / timeSinceLastUpdate) * 1000;
    }
    
    // Calculate ETA
    const remainingItems = total - itemsProcessed;
    if (this.progressState.itemsPerSecond > 0) {
      this.progressState.estimatedTimeRemaining = remainingItems / this.progressState.itemsPerSecond;
    }
    
    // Update tracking
    this.progressState.lastUpdateTime = now;
    this.progressState.lastUpdateCount = itemsProcessed;
    
    // Display progress
    this.displayProgress();
  }

  /**
   * Display progress bar and stats
   */
  private displayProgress(options?: { showProgress?: boolean; compact?: boolean }): void {
    // Skip progress display if not enabled
    if (options?.showProgress === false) return;
    const { processedItems, totalItems, currentPhase, itemsPerSecond, estimatedTimeRemaining } = this.progressState;
    
    if (totalItems === 0) return;
    
    const percentage = Math.round((processedItems / totalItems) * 100);
    const barLength = 40;
    const filledLength = Math.round((processedItems / totalItems) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    
    // Format ETA
    let etaString = '';
    if (estimatedTimeRemaining > 0 && estimatedTimeRemaining < Infinity) {
      const minutes = Math.floor(estimatedTimeRemaining / 60);
      const seconds = Math.round(estimatedTimeRemaining % 60);
      etaString = minutes > 0 ? ` ETA: ${minutes}m ${seconds}s` : ` ETA: ${seconds}s`;
    }
    
    // Format speed
    const speedString = itemsPerSecond > 0 ? ` (${Math.round(itemsPerSecond)} items/sec)` : '';
    
    // Clear line and print progress
    process.stdout.write('\r\x1b[K'); // Clear current line
    process.stdout.write(
      `[${currentPhase}] ${bar} ${percentage}% | ${processedItems}/${totalItems}${speedString}${etaString}`
    );
    
    // Add newline when complete
    if (processedItems === totalItems) {
      process.stdout.write('\n');
    }
  }

  /**
   * Track memory usage
   */
  private trackMemoryUsage(): void {
    if (global.gc) {
      global.gc(); // Force garbage collection if available
    }
    const usage = process.memoryUsage();
    this.memorySnapshots.push(usage.heapUsed / 1024 / 1024); // MB
  }

  /**
   * Generate migration report
   */
  private generateReport(sourcePath: string, targetPath: string, options: MigrationOptions): MigrationReport {
    const duration = this.migrationStats.endTime - this.migrationStats.startTime;
    const totalRead = this.migrationStats.entitiesRead + this.migrationStats.observationsRead + this.migrationStats.relationsRead;
    const totalWritten = this.migrationStats.entitiesWritten + this.migrationStats.observationsWritten + this.migrationStats.relationsWritten;
    const totalSkipped = this.migrationStats.entitiesSkipped + this.migrationStats.observationsSkipped + this.migrationStats.relationsSkipped;
    
    const avgMemory = this.memorySnapshots.length > 0 
      ? this.memorySnapshots.reduce((a, b) => a + b, 0) / this.memorySnapshots.length 
      : 0;
    const peakMemory = this.memorySnapshots.length > 0 
      ? Math.max(...this.memorySnapshots) 
      : 0;
    
    return {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      duration: duration / 1000, // seconds
      source: sourcePath,
      target: targetPath,
      options,
      summary: {
        totalRead,
        totalWritten,
        totalSkipped,
        successRate: totalRead > 0 ? (totalWritten / totalRead) * 100 : 0,
      },
      details: {
        entities: {
          read: this.migrationStats.entitiesRead,
          written: this.migrationStats.entitiesWritten,
          skipped: this.migrationStats.entitiesSkipped,
          writeSpeed: duration > 0 ? (this.migrationStats.entitiesWritten / (duration / 1000)) : 0,
        },
        observations: {
          read: this.migrationStats.observationsRead,
          written: this.migrationStats.observationsWritten,
          skipped: this.migrationStats.observationsSkipped,
          writeSpeed: duration > 0 ? (this.migrationStats.observationsWritten / (duration / 1000)) : 0,
        },
        relations: {
          read: this.migrationStats.relationsRead,
          written: this.migrationStats.relationsWritten,
          skipped: this.migrationStats.relationsSkipped,
          writeSpeed: duration > 0 ? (this.migrationStats.relationsWritten / (duration / 1000)) : 0,
        },
      },
      performance: {
        avgItemsPerSecond: duration > 0 ? (totalWritten / (duration / 1000)) : 0,
        batchProcessingTimes: this.batchProcessingTimes.slice(0, 100), // Keep first 100 samples
        memoryUsage: {
          peak: peakMemory,
          average: avgMemory,
        },
      },
      errorRecovery: {
        totalRetries: this.migrationStats.totalRetries,
        retriedBatches: this.migrationStats.retriedBatches,
        partialBatches: this.migrationStats.partialBatches,
        recoveredItems: this.migrationStats.recoveredItems,
        failedItems: this.migrationStats.failedItems.slice(0, 100), // Limit to first 100
      },
      warnings: this.migrationStats.warnings,
      errors: this.migrationStats.errors,
    };
  }

  /**
   * Export report to file
   */
  private async exportReport(report: MigrationReport, filePath: string, format: 'json' | 'html' = 'json'): Promise<void> {
    const fs = await import('fs/promises');
    
    if (format === 'json') {
      // Convert BigInt to string for JSON serialization
      const jsonReport = JSON.stringify(report, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      , 2);
      await fs.writeFile(filePath, jsonReport);
      this.logger.info(`Report exported to ${filePath} (JSON format)`);
    } else if (format === 'html') {
      const html = this.generateHTMLReport(report);
      await fs.writeFile(filePath, html);
      this.logger.info(`Report exported to ${filePath} (HTML format)`);
    }
  }

  /**
   * Generate HTML report
   */
  private generateHTMLReport(report: MigrationReport): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Migration Report - ${new Date(report.timestamp).toLocaleString()}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        h2 { color: #555; margin-top: 30px; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .summary-card { background: #f8f9fa; padding: 15px; border-radius: 5px; border-left: 4px solid #007bff; }
        .summary-card h3 { margin: 0 0 10px 0; color: #666; font-size: 14px; }
        .summary-card .value { font-size: 24px; font-weight: bold; color: #333; }
        .summary-card .unit { font-size: 14px; color: #666; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f8f9fa; font-weight: bold; }
        .success { color: #28a745; }
        .warning { color: #ffc107; }
        .error { color: #dc3545; }
        .progress-bar { width: 100%; height: 20px; background: #e9ecef; border-radius: 10px; overflow: hidden; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #007bff, #0056b3); transition: width 0.3s; }
        .badge { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: bold; }
        .badge-success { background: #d4edda; color: #155724; }
        .badge-warning { background: #fff3cd; color: #856404; }
        .badge-error { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <div class="container">
        <h1>DuckDB Migration Report</h1>
        <p><strong>Generated:</strong> ${new Date(report.timestamp).toLocaleString()}</p>
        <p><strong>Duration:</strong> ${report.duration.toFixed(2)} seconds</p>
        <p><strong>Source:</strong> <code>${report.source}</code></p>
        <p><strong>Target:</strong> <code>${report.target}</code></p>
        
        <h2>Summary</h2>
        <div class="summary">
            <div class="summary-card">
                <h3>Success Rate</h3>
                <div class="value">${report.summary.successRate.toFixed(1)}<span class="unit">%</span></div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${report.summary.successRate}%"></div>
                </div>
            </div>
            <div class="summary-card">
                <h3>Total Read</h3>
                <div class="value">${report.summary.totalRead.toLocaleString()}</div>
            </div>
            <div class="summary-card">
                <h3>Total Written</h3>
                <div class="value">${report.summary.totalWritten.toLocaleString()}</div>
            </div>
            <div class="summary-card">
                <h3>Total Skipped</h3>
                <div class="value">${report.summary.totalSkipped.toLocaleString()}</div>
            </div>
        </div>
        
        <h2>Detailed Statistics</h2>
        <table>
            <thead>
                <tr>
                    <th>Type</th>
                    <th>Read</th>
                    <th>Written</th>
                    <th>Skipped</th>
                    <th>Write Speed</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Entities</td>
                    <td>${report.details.entities.read.toLocaleString()}</td>
                    <td>${report.details.entities.written.toLocaleString()}</td>
                    <td>${report.details.entities.skipped.toLocaleString()}</td>
                    <td>${Math.round(report.details.entities.writeSpeed).toLocaleString()} items/sec</td>
                </tr>
                <tr>
                    <td>Observations</td>
                    <td>${report.details.observations.read.toLocaleString()}</td>
                    <td>${report.details.observations.written.toLocaleString()}</td>
                    <td>${report.details.observations.skipped.toLocaleString()}</td>
                    <td>${Math.round(report.details.observations.writeSpeed).toLocaleString()} items/sec</td>
                </tr>
                <tr>
                    <td>Relations</td>
                    <td>${report.details.relations.read.toLocaleString()}</td>
                    <td>${report.details.relations.written.toLocaleString()}</td>
                    <td>${report.details.relations.skipped.toLocaleString()}</td>
                    <td>${Math.round(report.details.relations.writeSpeed).toLocaleString()} items/sec</td>
                </tr>
            </tbody>
        </table>
        
        <h2>Performance Metrics</h2>
        <div class="summary">
            <div class="summary-card">
                <h3>Average Speed</h3>
                <div class="value">${Math.round(report.performance.avgItemsPerSecond).toLocaleString()}<span class="unit"> items/sec</span></div>
            </div>
            <div class="summary-card">
                <h3>Peak Memory</h3>
                <div class="value">${report.performance.memoryUsage.peak.toFixed(1)}<span class="unit"> MB</span></div>
            </div>
            <div class="summary-card">
                <h3>Avg Memory</h3>
                <div class="value">${report.performance.memoryUsage.average.toFixed(1)}<span class="unit"> MB</span></div>
            </div>
        </div>
        
        ${report.errorRecovery.totalRetries > 0 || report.errorRecovery.failedItems.length > 0 ? `
        <h2>Error Recovery</h2>
        <table>
            <tbody>
                <tr>
                    <td>Total Retries</td>
                    <td>${report.errorRecovery.totalRetries}</td>
                </tr>
                <tr>
                    <td>Retried Batches</td>
                    <td>${report.errorRecovery.retriedBatches}</td>
                </tr>
                <tr>
                    <td>Partial Batches</td>
                    <td>${report.errorRecovery.partialBatches}</td>
                </tr>
                <tr>
                    <td>Recovered Items</td>
                    <td>${report.errorRecovery.recoveredItems}</td>
                </tr>
                <tr>
                    <td>Failed Items</td>
                    <td>${report.errorRecovery.failedItems.length}</td>
                </tr>
            </tbody>
        </table>
        ` : ''}
        
        ${report.warnings.length > 0 ? `
        <h2>Warnings</h2>
        <ul>
            ${report.warnings.map(w => `<li class="warning">${w}</li>`).join('')}
        </ul>
        ` : ''}
        
        ${report.errors.length > 0 ? `
        <h2>Errors</h2>
        <ul>
            ${report.errors.map(e => `<li class="error">${e}</li>`).join('')}
        </ul>
        ` : ''}
        
        ${report.verification ? `
        <h2>Verification Results</h2>
        <table>
            <tbody>
                <tr>
                    <td>Entity Count Match</td>
                    <td><span class="badge ${report.verification.entityCountMatch ? 'badge-success' : 'badge-warning'}">${report.verification.entityCountMatch ? 'PASS' : 'MISMATCH'}</span></td>
                </tr>
                <tr>
                    <td>Observation Count Match</td>
                    <td><span class="badge ${report.verification.observationCountMatch ? 'badge-success' : 'badge-warning'}">${report.verification.observationCountMatch ? 'PASS' : 'MISMATCH'}</span></td>
                </tr>
                <tr>
                    <td>Relation Count Match</td>
                    <td><span class="badge ${report.verification.relationCountMatch ? 'badge-success' : 'badge-warning'}">${report.verification.relationCountMatch ? 'PASS' : 'MISMATCH'}</span></td>
                </tr>
                <tr>
                    <td>Orphaned Observations</td>
                    <td>${report.verification.orphanedObservations}</td>
                </tr>
                <tr>
                    <td>Invalid Relations</td>
                    <td>${report.verification.invalidRelations}</td>
                </tr>
            </tbody>
        </table>
        ` : ''}
    </div>
</body>
</html>`;
  }

  /**
   * Set error log file path for detailed error logging
   */
  setErrorLogFile(path: string): void {
    this.errorLogFile = path;
  }

  /**
   * Log error to file if error logging is enabled
   */
  private async logErrorToFile(error: any, context: string): Promise<void> {
    if (!this.errorLogFile) return;
    
    try {
      const fs = await import('fs/promises');
      const errorEntry = {
        timestamp: new Date().toISOString(),
        context,
        error: extractError(error).message,
        stack: error?.stack || 'No stack trace',
      };
      
      const logContent = JSON.stringify(errorEntry) + '\n';
      await fs.appendFile(this.errorLogFile, logContent);
    } catch (logError) {
      this.logger.debug('Failed to write to error log file', extractError(logError));
    }
  }

  /**
   * Validate that a database file exists and is accessible
   */
  private validateDatabaseFile(filePath: string): void {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    const fileSizeMB = stats.size / (1024 * 1024);
    if (fileSizeMB > this.MAX_FILE_SIZE_MB) {
      throw new Error(
        `File too large: ${fileSizeMB.toFixed(2)}MB exceeds maximum allowed size of ${this.MAX_FILE_SIZE_MB}MB`
      );
    }
  }

  /**
   * Read entities from source database with fault tolerance
   */
  private async readEntities(conn: DuckDBConnection, filterPrefix?: string): Promise<EntityData[]> {
    const entities: EntityData[] = [];
    this.progressState.currentPhase = 'reading';
    
    try {
      // Build query with optional filter
      let query = `
        SELECT name, entityType, created_at
        FROM entities
      `;
      
      if (filterPrefix) {
        query += ` WHERE name LIKE '${filterPrefix.replace(/'/g, "''")}__%' `;
      }
      
      query += ` ORDER BY name`;
      
      // Try standard query first
      const result = await conn.runAndReadAll(query);
      
      for (const row of result.getRows()) {
        entities.push({
          name: row[0] as string,
          entityType: row[1] as string,
          created_at: row[2] as string,
        });
      }
      
      this.logger.info(`Read ${entities.length} entities from source database`);
      this.updateProgress(entities.length, entities.length, 'reading');
    } catch (error) {
      this.logger.warn("Failed to read entities with standard query, trying fallback", extractError(error));
      this.migrationStats.warnings.push("Used fallback method to read entities");
      
      // Fallback: Try reading without ordering or with limited columns
      try {
        const result = await conn.runAndReadAll("SELECT name, entityType, created_at FROM entities");
        
        for (const row of result.getRows()) {
          entities.push({
            name: row[0] as string,
            entityType: row[1] as string,
            created_at: row[2] as string,
          });
        }
        
        this.logger.info(`Read ${entities.length} entities using fallback method`);
        this.updateProgress(entities.length, entities.length, 'reading');
      } catch (fallbackError) {
        this.logger.error("Failed to read entities even with fallback", extractError(fallbackError));
        this.migrationStats.errors.push(`Failed to read entities: ${extractError(fallbackError).message}`);
        throw fallbackError;
      }
    }
    
    this.migrationStats.entitiesRead = entities.length;
    return entities;
  }

  /**
   * Read observations from source database with fault tolerance
   */
  private async readObservations(conn: DuckDBConnection, filterPrefix?: string): Promise<ObservationData[]> {
    const observations: ObservationData[] = [];
    
    // First check if observations table exists
    try {
      const tableCheck = await conn.runAndReadAll(`
        SELECT COUNT(*) FROM information_schema.tables 
        WHERE table_name = 'observations'
      `);
      
      if (tableCheck.getRows()[0][0] === 0) {
        this.logger.warn("Observations table does not exist in source database");
        this.migrationStats.warnings.push("Observations table not found in source database");
        return [];
      }
    } catch (checkError) {
      this.logger.warn("Could not check if observations table exists", extractError(checkError));
    }
    
    try {
      // First, check if the observations table has the expected structure
      const schemaResult = await conn.runAndReadAll(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'observations'
        ORDER BY ordinal_position
      `);
      
      const columns = schemaResult.getRows().map(row => row[0] as string);
      this.logger.debug(`Observations table columns: ${columns.join(', ')}`);
      
      // Build query based on available columns
      let query: string;
      if (columns.includes('id')) {
        // New schema with id column
        query = `
          SELECT entityName, content, created_at
          FROM observations
        `;
      } else {
        // Old schema without id column
        query = `
          SELECT entityName, content, created_at
          FROM observations
        `;
      }
      
      if (filterPrefix) {
        query += ` WHERE entityName LIKE '${filterPrefix.replace(/'/g, "''")}__%' `;
      }
      
      query += ` ORDER BY entityName, created_at`;
      
      const result = await conn.runAndReadAll(query);
      
      for (const row of result.getRows()) {
        observations.push({
          entityName: row[0] as string,
          content: row[1] as string,
          created_at: row[2] as string,
        });
      }
      
      this.logger.info(`Read ${observations.length} observations from source database`);
      this.updateProgress(observations.length, observations.length, 'reading');
    } catch (error) {
      this.logger.warn("Failed to read observations with standard query, trying fallback", extractError(error));
      this.migrationStats.warnings.push("Used fallback method to read observations");
      
      // Fallback: Try reading without ordering
      try {
        const result = await conn.runAndReadAll("SELECT entityName, content, created_at FROM observations");
        
        for (const row of result.getRows()) {
          observations.push({
            entityName: row[0] as string,
            content: row[1] as string,
            created_at: row[2] as string,
          });
        }
        
        this.logger.info(`Read ${observations.length} observations using fallback method`);
        this.updateProgress(observations.length, observations.length, 'reading');
      } catch (fallbackError) {
        this.logger.error("Failed to read observations even with fallback", extractError(fallbackError));
        this.migrationStats.errors.push(`Failed to read observations: ${extractError(fallbackError).message}`);
        throw fallbackError;
      }
    }
    
    this.migrationStats.observationsRead = observations.length;
    return observations;
  }

  /**
   * Read relations from source database with fault tolerance
   */
  private async readRelations(conn: DuckDBConnection, filterPrefix?: string): Promise<RelationData[]> {
    const relations: RelationData[] = [];
    
    // First check if relations table exists
    try {
      const tableCheck = await conn.runAndReadAll(`
        SELECT COUNT(*) FROM information_schema.tables 
        WHERE table_name = 'relations'
      `);
      
      if (tableCheck.getRows()[0][0] === 0) {
        this.logger.warn("Relations table does not exist in source database");
        this.migrationStats.warnings.push("Relations table not found in source database");
        return [];
      }
    } catch (checkError) {
      this.logger.warn("Could not check if relations table exists", extractError(checkError));
    }
    
    try {
      let query = `
        SELECT from_entity, to_entity, relationType, created_at
        FROM relations
      `;
      
      if (filterPrefix) {
        query += ` WHERE from_entity LIKE '${filterPrefix.replace(/'/g, "''")}__%' 
                     OR to_entity LIKE '${filterPrefix.replace(/'/g, "''")}__%' `;
      }
      
      query += ` ORDER BY from_entity, to_entity, relationType`;
      
      const result = await conn.runAndReadAll(query);
      
      for (const row of result.getRows()) {
        relations.push({
          from_entity: row[0] as string,
          to_entity: row[1] as string,
          relationType: row[2] as string,
          created_at: row[3] as string,
        });
      }
      
      this.logger.info(`Read ${relations.length} relations from source database`);
      this.updateProgress(relations.length, relations.length, 'reading');
    } catch (error) {
      this.logger.warn("Failed to read relations with standard query, trying fallback", extractError(error));
      this.migrationStats.warnings.push("Used fallback method to read relations");
      
      // Fallback: Try reading without ordering
      try {
        const result = await conn.runAndReadAll("SELECT from_entity, to_entity, relationType, created_at FROM relations");
        
        for (const row of result.getRows()) {
          relations.push({
            from_entity: row[0] as string,
            to_entity: row[1] as string,
            relationType: row[2] as string,
            created_at: row[3] as string,
          });
        }
        
        this.logger.info(`Read ${relations.length} relations using fallback method`);
        this.updateProgress(relations.length, relations.length, 'reading');
      } catch (fallbackError) {
        this.logger.error("Failed to read relations even with fallback", extractError(fallbackError));
        this.migrationStats.errors.push(`Failed to read relations: ${extractError(fallbackError).message}`);
        throw fallbackError;
      }
    }
    
    this.migrationStats.relationsRead = relations.length;
    return relations;
  }

  /**
   * Sleep for specified milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Try to write a single item with retries
   */
  private async writeEntityWithRetry(
    conn: DuckDBConnection,
    entity: EntityData,
    maxRetries: number,
    retryDelay: number
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Escape single quotes in values
        const safeName = String(entity.name).replace(/'/g, "''");
        const safeType = String(entity.entityType).replace(/'/g, "''");
        const safeTime = String(entity.created_at).replace(/'/g, "''");
        
        await conn.run(`
          INSERT INTO entities (name, entityType, created_at)
          VALUES ('${safeName}', '${safeType}', '${safeTime}')
          ON CONFLICT (name) DO UPDATE SET
            entityType = EXCLUDED.entityType,
            created_at = LEAST(entities.created_at, EXCLUDED.created_at)
        `);
        return true;
      } catch (error) {
        const errorMsg = extractError(error).message;
        await this.logErrorToFile(error, `writeEntityWithRetry: ${entity.name}`);
        
        if (attempt < maxRetries) {
          this.migrationStats.totalRetries++;
          this.logger.debug(`Retry ${attempt + 1}/${maxRetries} for entity ${entity.name}: ${errorMsg}`);
          await this.sleep(retryDelay * (attempt + 1));
        } else {
          this.logger.debug(`Failed to write entity ${entity.name} after ${maxRetries} retries: ${errorMsg}`);
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Write entities to target database in batches with error recovery
   */
  private async writeEntities(
    conn: DuckDBConnection,
    entities: EntityData[],
    batchSize: number,
    options: { skipErrors: boolean; maxRetries: number; retryDelayMs: number; preserveTimestamps?: boolean }
  ): Promise<void> {
    // In dry-run mode, just simulate
    if (this.dryRunMode) {
      this.logger.info(`[DRY-RUN] Would write ${entities.length} entities in batches of ${batchSize}`);
      this.migrationStats.entitiesWritten = entities.length;
      this.migrationStats.entitiesSkipped = 0;
      return;
    }
    this.logger.info(`Writing ${entities.length} entities in batches of ${batchSize}`);
    this.progressState.currentPhase = 'writing-entities';
    this.updateProgress(0, entities.length, 'writing-entities');
    
    let written = 0;
    let skipped = 0;
    
    for (let i = 0; i < entities.length; i += batchSize) {
      const batchStartTime = Date.now();
      const batch = entities.slice(i, Math.min(i + batchSize, entities.length));
      let batchSuccess = false;
      let batchRetryCount = 0;
      
      // Try batch operation first
      while (!batchSuccess && batchRetryCount <= options.maxRetries) {
        try {
          await conn.run("BEGIN TRANSACTION");
          
          for (const entity of batch) {
            // Escape single quotes in values
            const safeName = String(entity.name).replace(/'/g, "''");
            const safeType = String(entity.entityType).replace(/'/g, "''");
            const safeTime = String(entity.created_at).replace(/'/g, "''");
            
            if (options.preserveTimestamps !== false) {
              await conn.run(`
                INSERT INTO entities (name, entityType, created_at)
                VALUES ('${safeName}', '${safeType}', '${safeTime}')
                ON CONFLICT (name) DO UPDATE SET
                  entityType = EXCLUDED.entityType,
                  created_at = LEAST(entities.created_at, EXCLUDED.created_at)
              `);
            } else {
              await conn.run(`
                INSERT INTO entities (name, entityType)
                VALUES ('${safeName}', '${safeType}')
                ON CONFLICT (name) DO UPDATE SET
                  entityType = EXCLUDED.entityType
              `);
            }
          }
          
          await conn.run("COMMIT");
          written += batch.length;
          batchSuccess = true;
          
          // Track batch processing time
          const batchTime = Date.now() - batchStartTime;
          this.batchProcessingTimes.push(batchTime);
          
          if (batchRetryCount > 0) {
            this.migrationStats.retriedBatches++;
          }
          
          // Update progress
          this.updateProgress(written, entities.length, 'writing-entities');
          
          // Track memory periodically
          if (i % (batchSize * 10) === 0) {
            this.trackMemoryUsage();
          }
        } catch (error) {
          await conn.run("ROLLBACK").catch(() => {}); // Ignore rollback errors
          
          const batchIndex = Math.floor(i / batchSize) + 1;
          const errorMsg = extractError(error).message;
          await this.logErrorToFile(error, `write batch ${batchIndex}`);
          
          if (batchRetryCount < options.maxRetries) {
            batchRetryCount++;
            this.migrationStats.totalRetries++;
            this.logger.warn(`Retrying batch ${batchIndex} (attempt ${batchRetryCount}/${options.maxRetries}): ${errorMsg}`);
            await this.sleep(options.retryDelayMs * batchRetryCount);
          } else if (options.skipErrors) {
            // Try individual inserts if batch fails
            this.logger.warn(`Batch ${batchIndex} failed at index ${i}, trying individual writes: ${errorMsg}`);
            this.migrationStats.partialBatches++;
            this.migrationStats.batchErrors.push({
              batchIndex,
              error: errorMsg,
              itemCount: batch.length
            });
            
            let batchWritten = 0;
            let batchSkipped = 0;
            
            for (let j = 0; j < batch.length; j++) {
              const entity = batch[j];
              const success = await this.writeEntityWithRetry(conn, entity, options.maxRetries, options.retryDelayMs);
              
              if (success) {
                batchWritten++;
                this.migrationStats.recoveredItems++;
              } else {
                batchSkipped++;
                this.migrationStats.failedItems.push({
                  type: 'entity',
                  index: i + j,
                  data: entity,
                  error: 'Failed after retries',
                  retryCount: options.maxRetries,
                  timestamp: new Date().toISOString(),
                  batchIndex: Math.floor(i / batchSize)
                });
              }
            }
            
            written += batchWritten;
            skipped += batchSkipped;
            batchSuccess = true; // Mark as handled
            
            const batchIdx = Math.floor(i / batchSize) + 1;
            this.logger.info(`Batch ${batchIdx}: ${batchWritten} written (recovered), ${batchSkipped} skipped`);
          } else {
            this.logger.error(`Failed to write entity batch starting at index ${i}`, extractError(error));
            this.migrationStats.errors.push(`Failed to write entity batch at index ${i}: ${extractError(error).message}`);
            throw error;
          }
        }
      }
    }
    
    this.migrationStats.entitiesWritten = written;
    this.migrationStats.entitiesSkipped = skipped;
    this.updateProgress(written, entities.length, 'writing-entities');
    this.logger.info(`Entities: ${written} written, ${skipped} skipped`);
  }

  /**
   * Try to write a single observation with retries
   */
  private async writeObservationWithRetry(
    conn: DuckDBConnection,
    obs: ObservationData,
    maxRetries: number,
    retryDelay: number
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Escape single quotes in values
        const safeName = String(obs.entityName).replace(/'/g, "''");
        const safeContent = String(obs.content).replace(/'/g, "''");
        const safeTime = String(obs.created_at).replace(/'/g, "''");
        
        await conn.run(`
          INSERT INTO observations (entityName, content, created_at)
          VALUES ('${safeName}', '${safeContent}', '${safeTime}')
        `);
        return true;
      } catch (error) {
        const errorMsg = extractError(error).message;
        await this.logErrorToFile(error, `writeObservationWithRetry`);
        
        if (attempt < maxRetries) {
          this.migrationStats.totalRetries++;
          this.logger.debug(`Retry ${attempt + 1}/${maxRetries} for observation: ${errorMsg}`);
          await this.sleep(retryDelay * (attempt + 1));
        } else {
          this.logger.debug(`Failed to write observation after ${maxRetries} retries: ${errorMsg}`);
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Write observations to target database in batches with error recovery
   */
  private async writeObservations(
    conn: DuckDBConnection,
    observations: ObservationData[],
    batchSize: number,
    options: { skipErrors: boolean; maxRetries: number; retryDelayMs: number; preserveTimestamps?: boolean }
  ): Promise<void> {
    // In dry-run mode, just simulate
    if (this.dryRunMode) {
      this.logger.info(`[DRY-RUN] Would write ${observations.length} observations in batches of ${batchSize}`);
      this.migrationStats.observationsWritten = observations.length;
      this.migrationStats.observationsSkipped = 0;
      return;
    }
    this.logger.info(`Writing ${observations.length} observations in batches of ${batchSize}`);
    this.progressState.currentPhase = 'writing-observations';
    this.updateProgress(0, observations.length, 'writing-observations');
    
    let written = 0;
    let skipped = 0;
    
    for (let i = 0; i < observations.length; i += batchSize) {
      const batchStartTime = Date.now();
      const batch = observations.slice(i, Math.min(i + batchSize, observations.length));
      let batchSuccess = false;
      let batchRetryCount = 0;
      
      // Try batch operation first
      while (!batchSuccess && batchRetryCount <= options.maxRetries) {
        try {
          await conn.run("BEGIN TRANSACTION");
          
          for (const obs of batch) {
            // Escape single quotes in values
            const safeName = String(obs.entityName).replace(/'/g, "''");
            const safeContent = String(obs.content).replace(/'/g, "''");
            const safeTime = String(obs.created_at).replace(/'/g, "''");
            
            await conn.run(`
              INSERT INTO observations (entityName, content, created_at)
              VALUES ('${safeName}', '${safeContent}', '${safeTime}')
            `);
          }
          
          await conn.run("COMMIT");
          written += batch.length;
          batchSuccess = true;
          
          // Track batch processing time
          const batchTime = Date.now() - batchStartTime;
          this.batchProcessingTimes.push(batchTime);
          
          if (batchRetryCount > 0) {
            this.migrationStats.retriedBatches++;
          }
          
          // Update progress
          this.updateProgress(written, observations.length, 'writing-observations');
          
          // Track memory periodically
          if (i % (batchSize * 10) === 0) {
            this.trackMemoryUsage();
          }
        } catch (error) {
          await conn.run("ROLLBACK").catch(() => {}); // Ignore rollback errors
          
          const batchIndex = Math.floor(i / batchSize) + 1;
          const errorMsg = extractError(error).message;
          await this.logErrorToFile(error, `write batch ${batchIndex}`);
          
          if (batchRetryCount < options.maxRetries) {
            batchRetryCount++;
            this.migrationStats.totalRetries++;
            this.logger.warn(`Retrying batch ${batchIndex} (attempt ${batchRetryCount}/${options.maxRetries}): ${errorMsg}`);
            await this.sleep(options.retryDelayMs * batchRetryCount);
          } else if (options.skipErrors) {
            // Try individual inserts if batch fails
            this.logger.warn(`Batch ${batchIndex} failed at index ${i}, trying individual writes: ${errorMsg}`);
            this.migrationStats.partialBatches++;
            this.migrationStats.batchErrors.push({
              batchIndex,
              error: errorMsg,
              itemCount: batch.length
            });
            
            let batchWritten = 0;
            let batchSkipped = 0;
            
            for (let j = 0; j < batch.length; j++) {
              const obs = batch[j];
              const success = await this.writeObservationWithRetry(conn, obs, options.maxRetries, options.retryDelayMs);
              
              if (success) {
                batchWritten++;
                this.migrationStats.recoveredItems++;
              } else {
                batchSkipped++;
                this.migrationStats.failedItems.push({
                  type: 'observation',
                  index: i + j,
                  data: obs,
                  error: 'Failed after retries',
                  retryCount: options.maxRetries,
                  timestamp: new Date().toISOString(),
                  batchIndex: Math.floor(i / batchSize)
                });
              }
            }
            
            written += batchWritten;
            skipped += batchSkipped;
            batchSuccess = true; // Mark as handled
            
            const batchIdx = Math.floor(i / batchSize) + 1;
            this.logger.info(`Batch ${batchIdx}: ${batchWritten} written (recovered), ${batchSkipped} skipped`);
          } else {
            this.logger.error(`Failed to write observation batch starting at index ${i}`, extractError(error));
            this.migrationStats.errors.push(`Failed to write observation batch at index ${i}: ${extractError(error).message}`);
            throw error;
          }
        }
      }
    }
    
    this.migrationStats.observationsWritten = written;
    this.migrationStats.observationsSkipped = skipped;
    this.updateProgress(written, observations.length, 'writing-observations');
    this.logger.info(`Observations: ${written} written, ${skipped} skipped`);
  }

  /**
   * Try to write a single relation with retries
   */
  private async writeRelationWithRetry(
    conn: DuckDBConnection,
    rel: RelationData,
    maxRetries: number,
    retryDelay: number
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Escape single quotes in values
        const safeFrom = String(rel.from_entity).replace(/'/g, "''");
        const safeTo = String(rel.to_entity).replace(/'/g, "''");
        const safeType = String(rel.relationType).replace(/'/g, "''");
        const safeTime = String(rel.created_at).replace(/'/g, "''");
        
        await conn.run(`
          INSERT INTO relations (from_entity, to_entity, relationType, created_at)
          VALUES ('${safeFrom}', '${safeTo}', '${safeType}', '${safeTime}')
          ON CONFLICT (from_entity, to_entity, relationType) DO UPDATE SET
            created_at = LEAST(relations.created_at, EXCLUDED.created_at)
        `);
        return true;
      } catch (error) {
        const errorMsg = extractError(error).message;
        await this.logErrorToFile(error, `writeRelationWithRetry`);
        
        if (attempt < maxRetries) {
          this.migrationStats.totalRetries++;
          this.logger.debug(`Retry ${attempt + 1}/${maxRetries} for relation: ${errorMsg}`);
          await this.sleep(retryDelay * (attempt + 1));
        } else {
          this.logger.debug(`Failed to write relation after ${maxRetries} retries: ${errorMsg}`);
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Write relations to target database in batches with error recovery
   */
  private async writeRelations(
    conn: DuckDBConnection,
    relations: RelationData[],
    batchSize: number,
    options: { skipErrors: boolean; maxRetries: number; retryDelayMs: number; preserveTimestamps?: boolean }
  ): Promise<void> {
    // In dry-run mode, just simulate
    if (this.dryRunMode) {
      this.logger.info(`[DRY-RUN] Would write ${relations.length} relations in batches of ${batchSize}`);
      this.migrationStats.relationsWritten = relations.length;
      this.migrationStats.relationsSkipped = 0;
      return;
    }
    this.logger.info(`Writing ${relations.length} relations in batches of ${batchSize}`);
    this.progressState.currentPhase = 'writing-relations';
    this.updateProgress(0, relations.length, 'writing-relations');
    
    let written = 0;
    let skipped = 0;
    
    for (let i = 0; i < relations.length; i += batchSize) {
      const batchStartTime = Date.now();
      const batch = relations.slice(i, Math.min(i + batchSize, relations.length));
      let batchSuccess = false;
      let batchRetryCount = 0;
      
      // Try batch operation first
      while (!batchSuccess && batchRetryCount <= options.maxRetries) {
        try {
          await conn.run("BEGIN TRANSACTION");
          
          for (const rel of batch) {
            // Escape single quotes in values
            const safeFrom = String(rel.from_entity).replace(/'/g, "''");
            const safeTo = String(rel.to_entity).replace(/'/g, "''");
            const safeType = String(rel.relationType).replace(/'/g, "''");
            const safeTime = String(rel.created_at).replace(/'/g, "''");
            
            await conn.run(`
              INSERT INTO relations (from_entity, to_entity, relationType, created_at)
              VALUES ('${safeFrom}', '${safeTo}', '${safeType}', '${safeTime}')
              ON CONFLICT (from_entity, to_entity, relationType) DO UPDATE SET
                created_at = LEAST(relations.created_at, EXCLUDED.created_at)
            `);
          }
          
          await conn.run("COMMIT");
          written += batch.length;
          batchSuccess = true;
          
          // Track batch processing time
          const batchTime = Date.now() - batchStartTime;
          this.batchProcessingTimes.push(batchTime);
          
          if (batchRetryCount > 0) {
            this.migrationStats.retriedBatches++;
          }
          
          // Update progress
          this.updateProgress(written, relations.length, 'writing-relations');
          
          // Track memory periodically
          if (i % (batchSize * 10) === 0) {
            this.trackMemoryUsage();
          }
        } catch (error) {
          await conn.run("ROLLBACK").catch(() => {}); // Ignore rollback errors
          
          const batchIndex = Math.floor(i / batchSize) + 1;
          const errorMsg = extractError(error).message;
          await this.logErrorToFile(error, `write batch ${batchIndex}`);
          
          if (batchRetryCount < options.maxRetries) {
            batchRetryCount++;
            this.migrationStats.totalRetries++;
            this.logger.warn(`Retrying batch ${batchIndex} (attempt ${batchRetryCount}/${options.maxRetries}): ${errorMsg}`);
            await this.sleep(options.retryDelayMs * batchRetryCount);
          } else if (options.skipErrors) {
            // Try individual inserts if batch fails
            this.logger.warn(`Batch ${batchIndex} failed at index ${i}, trying individual writes: ${errorMsg}`);
            this.migrationStats.partialBatches++;
            this.migrationStats.batchErrors.push({
              batchIndex,
              error: errorMsg,
              itemCount: batch.length
            });
            
            let batchWritten = 0;
            let batchSkipped = 0;
            
            for (let j = 0; j < batch.length; j++) {
              const rel = batch[j];
              const success = await this.writeRelationWithRetry(conn, rel, options.maxRetries, options.retryDelayMs);
              
              if (success) {
                batchWritten++;
                this.migrationStats.recoveredItems++;
              } else {
                batchSkipped++;
                this.migrationStats.failedItems.push({
                  type: 'relation',
                  index: i + j,
                  data: rel,
                  error: 'Failed after retries',
                  retryCount: options.maxRetries,
                  timestamp: new Date().toISOString(),
                  batchIndex: Math.floor(i / batchSize)
                });
              }
            }
            
            written += batchWritten;
            skipped += batchSkipped;
            batchSuccess = true; // Mark as handled
            
            const batchIdx = Math.floor(i / batchSize) + 1;
            this.logger.info(`Batch ${batchIdx}: ${batchWritten} written (recovered), ${batchSkipped} skipped`);
          } else {
            this.logger.error(`Failed to write relation batch starting at index ${i}`, extractError(error));
            this.migrationStats.errors.push(`Failed to write relation batch at index ${i}: ${extractError(error).message}`);
            throw error;
          }
        }
      }
    }
    
    this.migrationStats.relationsWritten = written;
    this.migrationStats.relationsSkipped = skipped;
    this.updateProgress(written, relations.length, 'writing-relations');
    this.logger.info(`Relations: ${written} written, ${skipped} skipped`);
  }

  /**
   * Verify data integrity after migration
   */
  private async verifyMigration(
    targetConn: DuckDBConnection,
    expectedCounts: { entities: number; observations: number; relations: number }
  ): Promise<{ entityCountMatch: boolean; observationCountMatch: boolean; relationCountMatch: boolean; orphanedObservations: number; invalidRelations: number }> {
    this.logger.info("Verifying migration integrity...");
    this.progressState.currentPhase = 'verifying';
    
    // Check entity count
    const entityResult = await targetConn.runAndReadAll("SELECT COUNT(*) FROM entities");
    const entityCount = entityResult.getRows()[0][0] as number;
    
    // Check observation count
    const obsResult = await targetConn.runAndReadAll("SELECT COUNT(*) FROM observations");
    const obsCount = obsResult.getRows()[0][0] as number;
    
    // Check relation count
    const relResult = await targetConn.runAndReadAll("SELECT COUNT(*) FROM relations");
    const relCount = relResult.getRows()[0][0] as number;
    
    // Check for orphaned observations
    const orphanedResult = await targetConn.runAndReadAll(`
      SELECT COUNT(*) FROM observations o
      WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = o.entityName)
    `);
    const orphanedCount = orphanedResult.getRows()[0][0] as number;
    
    // Check for invalid relations
    const invalidResult = await targetConn.runAndReadAll(`
      SELECT COUNT(*) FROM relations r
      WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = r.from_entity)
         OR NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = r.to_entity)
    `);
    const invalidCount = invalidResult.getRows()[0][0] as number;
    
    // Report verification results
    const verification = {
      entityCountMatch: entityCount <= expectedCounts.entities,
      observationCountMatch: obsCount === expectedCounts.observations,
      relationCountMatch: relCount <= expectedCounts.relations,
      orphanedObservations: orphanedCount,
      invalidRelations: invalidCount,
    };
    
    this.logger.info("Migration verification complete", {
      entities: { expected: expectedCounts.entities, actual: entityCount, match: verification.entityCountMatch },
      observations: { expected: expectedCounts.observations, actual: obsCount, match: verification.observationCountMatch },
      relations: { expected: expectedCounts.relations, actual: relCount, match: verification.relationCountMatch },
      orphanedObservations: orphanedCount,
      invalidRelations: invalidCount,
    });
    
    if (orphanedCount > 0) {
      this.migrationStats.warnings.push(`Found ${orphanedCount} orphaned observations`);
    }
    
    if (invalidCount > 0) {
      this.migrationStats.warnings.push(`Found ${invalidCount} invalid relations`);
    }
    
    if (!verification.entityCountMatch || !verification.observationCountMatch || !verification.relationCountMatch) {
      this.migrationStats.warnings.push("Data count mismatch detected (may be due to deduplication)");
    }
    
    return verification;
  }

  /**
   * Main migration method
   */
  async migrate(
    sourcePath: string,
    targetPath: string,
    options: MigrationOptions = {
      batchSize: this.DEFAULT_BATCH_SIZE,
      verbose: false,
      skipValidation: false,
      skipErrors: false,
      maxRetries: this.DEFAULT_MAX_RETRIES,
      retryDelayMs: this.DEFAULT_RETRY_DELAY_MS,
      dryRun: false,
      showProgress: true,
      compact: false,
      preserveTimestamps: true,
    },
    exportFailedPath?: string,
    errorLogPath?: string,
    reportPath?: string,
    reportFormat?: 'json' | 'html'
  ): Promise<void> {
    this.migrationStats.startTime = Date.now();
    this.progressState.startTime = Date.now();
    this.progressState.lastUpdateTime = Date.now();
    this.dryRunMode = options.dryRun || false;
    
    // Set up error logging if requested
    if (errorLogPath) {
      this.setErrorLogFile(errorLogPath);
      this.logger.info(`Error logging enabled: ${errorLogPath}`);
    }
    
    if (options.verbose) {
      this.logger.setLevel(LogLevel.DEBUG);
    }
    
    if (this.dryRunMode) {
      this.logger.info("🔍 DRY-RUN MODE: No changes will be made to the target database");
    }
    
    const resolvedSourcePath = resolve(sourcePath);
    const resolvedTargetPath = resolve(targetPath);
    
    this.logger.info("Starting database migration", {
      source: resolvedSourcePath,
      target: resolvedTargetPath,
      batchSize: options.batchSize,
    });
    
    // Validate source database
    this.logger.info("Validating source database...");
    this.validateDatabaseFile(resolvedSourcePath);
    
    // Check if target already exists
    if (existsSync(resolvedTargetPath)) {
      this.logger.warn(`Target database already exists: ${resolvedTargetPath}`);
      if (!options.skipValidation) {
        throw new Error("Target database already exists. Use --skip-validation to overwrite.");
      }
    }
    
    let sourceInstance: DuckDBInstance | null = null;
    let sourceConn: DuckDBConnection | null = null;
    let targetInstance: DuckDBInstance | null = null;
    let targetConn: DuckDBConnection | null = null;
    
    try {
      // Open source database in read-only mode
      this.logger.info("Opening source database...");
      sourceInstance = await DuckDBInstance.create(resolvedSourcePath, { access_mode: "READ_ONLY" });
      sourceConn = await sourceInstance.connect();
      
      // Read all data from source
      this.logger.info("Reading data from source database...");
      if (options.filterPrefix) {
        this.logger.info(`Filtering data with prefix: ${options.filterPrefix}`);
      }
      const entities = await this.readEntities(sourceConn, options.filterPrefix);
      const observations = await this.readObservations(sourceConn, options.filterPrefix);
      const relations = await this.readRelations(sourceConn, options.filterPrefix);
      
      // Close source connection
      if (sourceConn) {
        // DuckDBConnection in node-api does not expose async close; use instance.close() instead in finally
        sourceConn = null;
      }
      
      // Create and initialize target database (skip in dry-run)
      if (!this.dryRunMode) {
        this.logger.info("Creating target database...");
        targetInstance = await DuckDBInstance.create(resolvedTargetPath);
        targetConn = await targetInstance.connect();
        
        // Create schema in target database
        this.logger.info("Creating schema in target database...");
        await this.createSchema(targetConn);
      } else {
        this.logger.info("[DRY-RUN] Would create target database: " + resolvedTargetPath);
      }
      
      // Write data to target database
      if (!this.dryRunMode) {
        this.logger.info("Writing data to target database...");
      } else {
        this.logger.info("[DRY-RUN] Simulating data write to target database...");
      }
      const writeOptions = {
        skipErrors: options.skipErrors,
        maxRetries: options.maxRetries,
        retryDelayMs: options.retryDelayMs,
        preserveTimestamps: options.preserveTimestamps
      };
      if (targetConn) {
        await this.writeEntities(targetConn, entities, options.batchSize, writeOptions);
        await this.writeObservations(targetConn, observations, options.batchSize, writeOptions);
        await this.writeRelations(targetConn, relations, options.batchSize, writeOptions);
      }
      
      // Verify migration if not skipped (skip in dry-run)
      let verificationResult;
      if (!options.skipValidation && !this.dryRunMode && targetConn) {
        verificationResult = await this.verifyMigration(targetConn, {
          entities: entities.length,
          observations: observations.length,
          relations: relations.length,
        });
      }
      
      // Force checkpoint to ensure data is persisted (skip in dry-run)
      if (!this.dryRunMode && targetConn) {
        this.logger.info("Forcing checkpoint to persist data...");
        try {
          await targetConn.run("CHECKPOINT");
          this.logger.info("Checkpoint completed successfully");
        } catch (checkpointError) {
          this.logger.warn("Checkpoint failed but data is committed", extractError(checkpointError));
          this.migrationStats.warnings.push("Checkpoint failed but data is safe");
        }
      }
      
      this.migrationStats.endTime = Date.now();
      
      // Generate and export report if requested
      if (reportPath) {
        const report = this.generateReport(resolvedSourcePath, resolvedTargetPath, options);
        if (verificationResult) {
          report.verification = verificationResult;
        }
        await this.exportReport(report, reportPath, reportFormat || 'json');
      }
      
      this.printMigrationReport();
      
      // Export failed items if requested
      if (exportFailedPath && this.migrationStats.failedItems.length > 0) {
        await this.exportFailedItems(exportFailedPath);
      }
      
      // If skipErrors is enabled and we have partial success, don't throw
      if (options.skipErrors && this.migrationStats.failedItems.length > 0) {
        const totalItems = this.migrationStats.entitiesRead + this.migrationStats.observationsRead + this.migrationStats.relationsRead;
        const totalWritten = this.migrationStats.entitiesWritten + this.migrationStats.observationsWritten + this.migrationStats.relationsWritten;
        const successRate = (totalWritten / totalItems * 100).toFixed(1);
        const recoveryRate = this.migrationStats.recoveredItems > 0 
          ? ` (${this.migrationStats.recoveredItems} items recovered through individual retry)`
          : '';
        this.logger.warn(`Migration completed with ${successRate}% success rate${recoveryRate}`);
      }
      
    } catch (error) {
      this.logger.error("Migration failed", extractError(error));
      this.migrationStats.errors.push(`Migration failed: ${extractError(error).message}`);
      this.migrationStats.endTime = Date.now();
      
      // Generate and export report even on error
      if (reportPath) {
        const report = this.generateReport(resolvedSourcePath, resolvedTargetPath, options);
        await this.exportReport(report, reportPath, reportFormat || 'json');
      }
      
      this.printMigrationReport();
      
      // Export failed items even on error
      if (exportFailedPath && this.migrationStats.failedItems.length > 0) {
        await this.exportFailedItems(exportFailedPath);
      }
      
      // If skipErrors is enabled and we have some success, return without throwing
      if (options.skipErrors) {
        const totalWritten = this.migrationStats.entitiesWritten + this.migrationStats.observationsWritten + this.migrationStats.relationsWritten;
        if (totalWritten > 0) {
          this.logger.warn("Migration partially completed due to skipErrors flag");
          return;
        }
      }
      
      throw error;
    } finally {
      // Clean up connections
      // Close instances rather than connections (node-api)
      if (sourceInstance) {
        sourceInstance.closeSync();
      }
      if (targetInstance) {
        targetInstance.closeSync();
      }
    }
  }

  /**
   * Create schema in target database
   */
  private async createSchema(conn: DuckDBConnection): Promise<void> {
    // Create entities table
    await conn.run(`
      CREATE TABLE IF NOT EXISTS entities (
        name VARCHAR PRIMARY KEY,
        entityType VARCHAR NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create observations table with id column
    await conn.run(`
      CREATE SEQUENCE IF NOT EXISTS observations_id_seq
    `);
    
    await conn.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY DEFAULT nextval('observations_id_seq'),
        entityName VARCHAR NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entityName) REFERENCES entities(name)
      )
    `);
    
    // Create indexes for observations
    await conn.run(`
      CREATE INDEX IF NOT EXISTS idx_observations_entity 
      ON observations(entityName)
    `);
    
    await conn.run(`
      CREATE INDEX IF NOT EXISTS idx_observations_created 
      ON observations(created_at)
    `);
    
    // Create relations table
    await conn.run(`
      CREATE TABLE IF NOT EXISTS relations (
        from_entity VARCHAR NOT NULL,
        to_entity VARCHAR NOT NULL,
        relationType VARCHAR NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (from_entity, to_entity, relationType),
        FOREIGN KEY (from_entity) REFERENCES entities(name),
        FOREIGN KEY (to_entity) REFERENCES entities(name)
      )
    `);
    
    // Create indexes for relations
    await conn.run(`
      CREATE INDEX IF NOT EXISTS idx_relations_from 
      ON relations(from_entity)
    `);
    
    await conn.run(`
      CREATE INDEX IF NOT EXISTS idx_relations_to 
      ON relations(to_entity)
    `);
    
    await conn.run(`
      CREATE INDEX IF NOT EXISTS idx_relations_type 
      ON relations(relationType)
    `);
    
    this.logger.info("Schema created successfully");
  }

  /**
   * Export failed items to a file for later analysis
   */
  private async exportFailedItems(filePath: string): Promise<void> {
    if (this.migrationStats.failedItems.length === 0) {
      return;
    }
    
    try {
      const fs = await import('fs/promises');
      const failedData = {
        timestamp: new Date().toISOString(),
        totalFailed: this.migrationStats.failedItems.length,
        summary: {
          entities: this.migrationStats.failedItems.filter(i => i.type === 'entity').length,
          observations: this.migrationStats.failedItems.filter(i => i.type === 'observation').length,
          relations: this.migrationStats.failedItems.filter(i => i.type === 'relation').length,
        },
        batchErrors: this.migrationStats.batchErrors,
        items: this.migrationStats.failedItems
      };
      
      // Convert BigInt to string for JSON serialization
      const jsonData = JSON.stringify(failedData, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      , 2);
      await fs.writeFile(filePath, jsonData);
      this.logger.info(`Failed items exported to ${filePath}`);
    } catch (error) {
      this.logger.warn(`Could not export failed items: ${extractError(error).message}`);
    }
  }

  /**
   * Print migration report
   */
  private printMigrationReport(compact: boolean = false): void {
    if (this.dryRunMode) {
      console.log("\n🔍 DRY-RUN MODE: No actual changes were made\n");
    }
    
    if (compact) {
      // Compact report format
      const duration = this.migrationStats.endTime - this.migrationStats.startTime;
      const totalRead = this.migrationStats.entitiesRead + this.migrationStats.observationsRead + this.migrationStats.relationsRead;
      const totalWritten = this.migrationStats.entitiesWritten + this.migrationStats.observationsWritten + this.migrationStats.relationsWritten;
      const totalSkipped = this.migrationStats.entitiesSkipped + this.migrationStats.observationsSkipped + this.migrationStats.relationsSkipped;
      
      console.log(`Migration Summary: ${totalRead} read → ${totalWritten} written (${totalSkipped} skipped) in ${(duration / 1000).toFixed(2)}s`);
      
      if (this.migrationStats.errors.length > 0) {
        console.log(`❌ ${this.migrationStats.errors.length} errors occurred`);
      } else if (this.migrationStats.failedItems.length > 0) {
        console.log(`⚠️  ${this.migrationStats.failedItems.length} items failed`);
      } else {
        console.log("✅ Success");
      }
      return;
    }
    const duration = this.migrationStats.endTime - this.migrationStats.startTime;
    
    console.log("\n" + "=".repeat(60));
    console.log("DATABASE MIGRATION REPORT");
    console.log("=".repeat(60));
    
    console.log("\n📊 MIGRATION STATISTICS:");
    console.log(`  Entities:     ${this.migrationStats.entitiesRead} read → ${this.migrationStats.entitiesWritten} written` +
                (this.migrationStats.entitiesSkipped > 0 ? ` (${this.migrationStats.entitiesSkipped} skipped)` : ''));
    console.log(`  Observations: ${this.migrationStats.observationsRead} read → ${this.migrationStats.observationsWritten} written` +
                (this.migrationStats.observationsSkipped > 0 ? ` (${this.migrationStats.observationsSkipped} skipped)` : ''));
    console.log(`  Relations:    ${this.migrationStats.relationsRead} read → ${this.migrationStats.relationsWritten} written` +
                (this.migrationStats.relationsSkipped > 0 ? ` (${this.migrationStats.relationsSkipped} skipped)` : ''));
    console.log(`  Duration:     ${(duration / 1000).toFixed(2)} seconds`);
    
    if (this.migrationStats.partialBatches > 0 || this.migrationStats.retriedBatches > 0 || this.migrationStats.totalRetries > 0) {
      console.log("\n🔄 ERROR RECOVERY:");
      if (this.migrationStats.totalRetries > 0) {
        console.log(`  Total retry attempts: ${this.migrationStats.totalRetries}`);
      }
      if (this.migrationStats.retriedBatches > 0) {
        console.log(`  Batches successfully retried: ${this.migrationStats.retriedBatches}`);
      }
      if (this.migrationStats.partialBatches > 0) {
        console.log(`  Partial batches: ${this.migrationStats.partialBatches} (batch failed, items processed individually)`);
      }
      if (this.migrationStats.recoveredItems > 0) {
        console.log(`  Items recovered individually: ${this.migrationStats.recoveredItems}`);
      }
      if (this.migrationStats.batchErrors.length > 0) {
        console.log(`\n  Batch failures:`);
        for (const batchError of this.migrationStats.batchErrors.slice(0, 5)) {
          console.log(`    - Batch ${batchError.batchIndex} (${batchError.itemCount} items): ${batchError.error}`);
        }
        if (this.migrationStats.batchErrors.length > 5) {
          console.log(`    ... and ${this.migrationStats.batchErrors.length - 5} more`);
        }
      }
    }
    
    if (this.migrationStats.failedItems.length > 0) {
      console.log("\n⚠️  FAILED ITEMS:");
      const byType = {
        entity: this.migrationStats.failedItems.filter(item => item.type === 'entity').length,
        observation: this.migrationStats.failedItems.filter(item => item.type === 'observation').length,
        relation: this.migrationStats.failedItems.filter(item => item.type === 'relation').length,
      };
      console.log(`  Total failed: ${this.migrationStats.failedItems.length}`);
      console.log(`  - Entities: ${byType.entity}`);
      console.log(`  - Observations: ${byType.observation}`);
      console.log(`  - Relations: ${byType.relation}`);
      console.log(`  \n  Failed items have been logged. Use --export-failed to save them to a file.`);
      
      // Show first few failed items as examples
      const exampleCount = Math.min(3, this.migrationStats.failedItems.length);
      if (exampleCount > 0) {
        console.log(`\n  First ${exampleCount} failed items:`);
        for (let i = 0; i < exampleCount; i++) {
          const item = this.migrationStats.failedItems[i];
          console.log(`    ${i + 1}. ${item.type} at index ${item.index}: ${item.error}`);
        }
      }
    }
    
    if (this.migrationStats.warnings.length > 0) {
      console.log("\n⚠️  WARNINGS:");
      for (const warning of this.migrationStats.warnings) {
        console.log(`  - ${warning}`);
      }
    }
    
    if (this.migrationStats.errors.length > 0) {
      console.log("\n❌ ERRORS:");
      for (const error of this.migrationStats.errors) {
        console.log(`  - ${error}`);
      }
    }
    
    console.log("\n" + "=".repeat(60));
    let status: string;
    if (this.migrationStats.errors.length === 0) {
      if (this.migrationStats.failedItems.length === 0) {
        status = "✅ SUCCESS";
      } else {
        status = "⚠️  PARTIAL SUCCESS";
      }
    } else {
      status = "❌ FAILED";
    }
    console.log(`STATUS: ${status}`);
    console.log("=".repeat(60) + "\n");
  }

  /**
   * Print version information
   */
  printVersion(): void {
    console.log(`migrate-database version ${this.VERSION}`);
    console.log(`MCP DuckDB Memory Server ${this.VERSION}`);
    console.log(`Node.js ${process.version}`);
  }

  /**
   * Print usage information
   */
  printUsage(): void {
    console.log(`
migrate-database v${this.VERSION}

Usage: migrate-database <source.db> <target.db> [options]

Migrates data from a source DuckDB database to a new target database.
Handles schema differences and provides fault-tolerant data reading.

Arguments:
  source.db             Path to the source database
  target.db             Path where the migrated database will be created

Options:
  --batch-size <n>      Number of records to process in each batch (default: ${this.DEFAULT_BATCH_SIZE})
  --verbose             Enable verbose logging
  --skip-validation     Skip post-migration validation checks
  --skip-errors         Continue processing even if some items fail
  --max-retries <n>     Maximum retry attempts for failed operations (default: ${this.DEFAULT_MAX_RETRIES})
  --retry-delay <ms>    Base delay between retries in milliseconds (default: ${this.DEFAULT_RETRY_DELAY_MS})
  --filter-prefix <pre> Only migrate entities with specified prefix (e.g., 'project1')
  --dry-run             Simulate migration without making changes
  --no-progress         Disable progress bar display
  --compact             Use compact output format
  --no-timestamps       Don't preserve original timestamps (use current time)
  --export-failed <file> Export failed items to JSON file for analysis
  --error-log <file>    Write detailed error logs to specified file
  --report <file>       Generate migration report (supports .json or .html extension)
  --report-format <fmt> Report format: json or html (default: json, ignored if extension provided)
  --help, -h            Show this help message
  --version, -v         Show version information

Environment Variables:
  BATCH_SIZE            Override default batch size (default: ${this.DEFAULT_BATCH_SIZE})
  MAX_RETRIES           Override default max retries (default: ${this.DEFAULT_MAX_RETRIES})  
  RETRY_DELAY_MS        Override default retry delay (default: ${this.DEFAULT_RETRY_DELAY_MS})
  DEBUG                 Enable debug logging (same as --verbose)

Features:
  - Fault-tolerant reading (handles corrupted or problematic source databases)
  - Batch processing for efficient memory usage
  - Automatic retry logic with exponential backoff
  - Individual item recovery when batches fail (with --skip-errors)
  - Detailed error tracking and reporting
  - Export failed items for later analysis
  - Partial success handling
  - Automatic deduplication
  - Schema migration to latest version
  - Referential integrity verification

Examples:
  # Basic migration
  migrate-database old.db new.db
  
  # Dry-run to preview migration
  migrate-database source.db target.db --dry-run
  
  # Migrate only specific project data
  migrate-database full.db project1.db --filter-prefix "project1"
  
  # Migration with error recovery
  migrate-database damaged.db repaired.db --skip-errors --export-failed failed.json
  
  # Verbose migration with custom batch size and retries
  migrate-database large.db optimized.db --batch-size 500 --verbose --max-retries 5
  
  # Compact output without progress bar
  migrate-database source.db target.db --compact --no-progress
  
  # Continue on errors with detailed logging
  migrate-database problematic.db recovered.db --skip-errors --verbose --export-failed errors.json
  
  # Full error recovery with detailed logging
  migrate-database corrupted.db fixed.db --skip-errors --max-retries 5 --error-log errors.log --export-failed failed-items.json
  
  # Generate HTML report with progress tracking
  migrate-database source.db target.db --report migration-report.html
  
  # Generate JSON report with error recovery
  migrate-database damaged.db fixed.db --skip-errors --report report.json --export-failed failed.json
  
  # Use environment variables
  BATCH_SIZE=2000 DEBUG=1 migrate-database large.db optimized.db
`);
  }
}

// Main execution
async function main() {
  const tool = new DatabaseMigrationTool();
  
  const args = process.argv.slice(2);
  
  // Check for version flag
  if (args.length > 0 && (args[0] === "--version" || args[0] === "-v")) {
    tool.printVersion();
    process.exit(0);
  }
  
  // Check for help flag
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    tool.printUsage();
    process.exit(0);
  }
  
  // Validate required arguments
  const nonFlagArgs = args.filter(arg => !arg.startsWith('--'));
  if (nonFlagArgs.length < 2) {
    console.error("❌ Error: Source and target database paths are required\n");
    console.error("Usage: migrate-database <source.db> <target.db> [options]");
    console.error("\nTry 'migrate-database --help' for more information.");
    process.exit(1);
  }
  
  const sourcePath = nonFlagArgs[0];
  const targetPath = nonFlagArgs[1];
  
  // Validate source exists
  if (!existsSync(sourcePath)) {
    console.error(`❌ Error: Source database not found: ${sourcePath}`);
    process.exit(1);
  }
  
  // Parse options with environment variable support
  const options: MigrationOptions = {
    batchSize: parseInt(process.env.BATCH_SIZE || '') || 1000,
    verbose: process.env.DEBUG === '1' || process.env.DEBUG === 'true' || false,
    skipValidation: false,
    skipErrors: false,
    maxRetries: parseInt(process.env.MAX_RETRIES || '') || 3,
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '') || 1000,
    dryRun: false,
    showProgress: true,
    compact: false,
    preserveTimestamps: true,
  };
  
  let exportFailedPath: string | undefined;
  let errorLogPath: string | undefined;
  let reportPath: string | undefined;
  let reportFormat: 'json' | 'html' | undefined;
  
  for (let i = 0; i < args.length; i++) {
    // Skip non-flag arguments (source and target paths)
    if (!args[i].startsWith('--')) continue;
    
    switch (args[i]) {
      case "--batch-size":
        if (i + 1 < args.length) {
          const batchSize = parseInt(args[++i], 10);
          if (isNaN(batchSize) || batchSize <= 0) {
            console.error(`❌ Error: Invalid batch size: ${args[i]}`);
            console.error("Batch size must be a positive integer.");
            process.exit(1);
          }
          options.batchSize = batchSize;
        } else {
          console.error("❌ Error: --batch-size requires a value");
          process.exit(1);
        }
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--skip-validation":
        options.skipValidation = true;
        break;
      case "--skip-errors":
        options.skipErrors = true;
        break;
      case "--filter-prefix":
        if (i + 1 < args.length) {
          options.filterPrefix = args[++i];
        } else {
          console.error("❌ Error: --filter-prefix requires a value");
          process.exit(1);
        }
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-progress":
        options.showProgress = false;
        break;
      case "--compact":
        options.compact = true;
        break;
      case "--no-timestamps":
        options.preserveTimestamps = false;
        break;
      case "--max-retries":
        if (i + 1 < args.length) {
          const maxRetries = parseInt(args[++i], 10);
          if (isNaN(maxRetries) || maxRetries < 0) {
            console.error(`❌ Error: Invalid max retries: ${args[i]}`);
            console.error("Max retries must be a non-negative integer.");
            process.exit(1);
          }
          options.maxRetries = maxRetries;
        } else {
          console.error("❌ Error: --max-retries requires a value");
          process.exit(1);
        }
        break;
      case "--retry-delay":
        if (i + 1 < args.length) {
          const retryDelay = parseInt(args[++i], 10);
          if (isNaN(retryDelay) || retryDelay < 0) {
            console.error(`❌ Error: Invalid retry delay: ${args[i]}`);
            console.error("Retry delay must be a non-negative integer (milliseconds).");
            process.exit(1);
          }
          options.retryDelayMs = retryDelay;
        } else {
          console.error("❌ Error: --retry-delay requires a value");
          process.exit(1);
        }
        break;
      case "--export-failed":
        if (i + 1 < args.length) {
          exportFailedPath = args[++i];
        } else {
          console.error("❌ Error: --export-failed requires a file path");
          process.exit(1);
        }
        break;
      case "--error-log":
        if (i + 1 < args.length) {
          errorLogPath = args[++i];
        } else {
          console.error("❌ Error: --error-log requires a file path");
          process.exit(1);
        }
        break;
      case "--report":
        if (i + 1 < args.length) {
          reportPath = args[++i];
          // Auto-detect format from extension
          if (reportPath.endsWith('.html')) {
            reportFormat = 'html';
          } else if (reportPath.endsWith('.json')) {
            reportFormat = 'json';
          } else {
            // Default to JSON if no recognized extension
            reportFormat = 'json';
          }
        } else {
          console.error("❌ Error: --report requires a file path");
          process.exit(1);
        }
        break;
      case "--report-format":
        if (i + 1 < args.length) {
          const fmt = args[++i].toLowerCase();
          if (fmt === 'json' || fmt === 'html') {
            reportFormat = fmt;
          } else {
            console.error(`Invalid report format: ${fmt}. Must be 'json' or 'html'`);
            process.exit(1);
          }
        }
        break;
      default:
        console.error(`❌ Error: Unknown option: ${args[i]}`);
        console.error("\nTry 'migrate-database --help' for a list of available options.");
        process.exit(1);
    }
  }
  
  // Display configuration summary if verbose or dry-run
  if (options.verbose || options.dryRun) {
    console.log("\n📋 Migration Configuration:");
    console.log(`  Source: ${sourcePath}`);
    console.log(`  Target: ${targetPath}`);
    console.log(`  Batch Size: ${options.batchSize}`);
    console.log(`  Max Retries: ${options.maxRetries}`);
    console.log(`  Retry Delay: ${options.retryDelayMs}ms`);
    if (options.filterPrefix) console.log(`  Filter Prefix: ${options.filterPrefix}`);
    if (options.dryRun) console.log(`  Mode: DRY-RUN`);
    if (options.skipErrors) console.log(`  Skip Errors: Yes`);
    if (options.skipValidation) console.log(`  Skip Validation: Yes`);
    if (!options.preserveTimestamps) console.log(`  Preserve Timestamps: No`);
    console.log("");
  }
  
  try {
    // Print starting message
    if (!options.compact) {
      console.log(`🚀 Starting migration from ${basename(sourcePath)} to ${basename(targetPath)}...\n`);
    }
    
    await tool.migrate(sourcePath, targetPath, options, exportFailedPath, errorLogPath, reportPath, reportFormat);
    
    // Check if we had partial success
    const stats = (tool as any).migrationStats;
    if (stats.failedItems.length > 0) {
      if (!options.compact) {
        console.log("\n⚠️  Migration completed with some items skipped");
      }
      process.exit(options.skipErrors ? 0 : 1);
    } else {
      if (!options.compact) {
        console.log("\n✅ Migration completed successfully!");
      }
      process.exit(0);
    }
  } catch (error) {
    const errorMsg = extractError(error).message;
    console.error("\n❌ Migration failed:", errorMsg);
    
    // Provide helpful error messages for common issues
    if (errorMsg.includes('already exists')) {
      console.error("\n💡 Tip: Use --skip-validation to overwrite existing target database.");
    } else if (errorMsg.includes('not found')) {
      console.error("\n💡 Tip: Check that the source database path is correct.");
    } else if (errorMsg.includes('permission')) {
      console.error("\n💡 Tip: Check file permissions for source and target paths.");
    }
    
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error("Unexpected error:", error);
    process.exit(1);
  });
}

export { DatabaseMigrationTool };