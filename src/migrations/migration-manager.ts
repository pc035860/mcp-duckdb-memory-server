import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { DuckDBConnection } from '@duckdb/node-api';
import { logger } from '../logger.js';
import { extractError } from '../utils.js';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface Migration {
  version: number;
  name: string;
  filename: string;
  sql: string;
}

export class MigrationManager {
  private connection: DuckDBConnection;
  private migrationsPath: string;

  constructor(connection: DuckDBConnection) {
    this.connection = connection;
    
    // Try to find the correct migrations path
    const possiblePaths = [
      join(__dirname, 'migrations'),        // If we're in dist/ and migrations is in dist/migrations/
      join(__dirname, '../migrations'),     // If we're in dist/some-subdir and migrations is in dist/migrations/
      resolve(process.cwd(), 'dist/migrations'),  // Absolute path from project root
    ];
    
    // Find the first path that exists
    this.migrationsPath = possiblePaths.find(path => existsSync(path)) || possiblePaths[0];
    
    logger.debug(`Migration path set to: ${this.migrationsPath}`);
  }

  /**
   * Initialize migration tracking table
   */
  async initializeMigrationTable(): Promise<void> {
    try {
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name VARCHAR NOT NULL,
          executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          checksum VARCHAR
        );
      `);
      logger.debug('Migration table initialized');
    } catch (error) {
      logger.error('Failed to initialize migration table', extractError(error));
      throw error;
    }
  }

  /**
   * Get list of applied migrations
   */
  async getAppliedMigrations(): Promise<number[]> {
    try {
      const result = await this.connection.runAndReadAll(`
        SELECT version FROM schema_migrations ORDER BY version
      `);
      
      const versions: number[] = [];
      const rows = result.getRows();
      
      for (const row of rows) {
        const version = row[0] as number;
        if (version !== null) {
          versions.push(version);
        }
      }
      
      return versions;
    } catch (error) {
      logger.debug('No migrations table found or error reading migrations');
      return [];
    }
  }

  /**
   * Load available migrations from files
   */
  private loadMigrations(): Migration[] {
    const migrations: Migration[] = [];
    
    // Define migrations manually for now (can be made dynamic later)
    const migrationFiles = [
      { version: 1, name: 'add-vss-support', filename: '001-add-vss-support.sql' }
    ];

    for (const migrationFile of migrationFiles) {
      try {
        const filePath = join(this.migrationsPath, migrationFile.filename);
        const sql = readFileSync(filePath, 'utf-8');
        
        migrations.push({
          version: migrationFile.version,
          name: migrationFile.name,
          filename: migrationFile.filename,
          sql
        });
      } catch (error) {
        logger.warn(`Failed to load migration ${migrationFile.filename}`, extractError(error));
      }
    }

    return migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Generate simple checksum for migration content
   */
  private generateChecksum(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  /**
   * Execute a single migration
   */
  private async executeMigration(migration: Migration): Promise<void> {
    const checksum = this.generateChecksum(migration.sql);
    
    try {
      logger.info(`Executing migration ${migration.version}: ${migration.name}`);
      
      // Execute the migration SQL
      await this.connection.run(migration.sql);
      
      // Record the migration as completed
      await this.connection.run(`
        INSERT INTO schema_migrations (version, name, checksum)
        VALUES (?, ?, ?)
      `, [migration.version, migration.name, checksum]);
      
      logger.info(`Migration ${migration.version} completed successfully`);
    } catch (error) {
      logger.error(`Migration ${migration.version} failed`, extractError(error));
      throw error;
    }
  }

  /**
   * Run all pending migrations
   */
  async runMigrations(): Promise<void> {
    try {
      // Initialize migration tracking
      await this.initializeMigrationTable();
      
      // Get applied and available migrations
      const appliedMigrations = await this.getAppliedMigrations();
      const availableMigrations = this.loadMigrations();
      
      // Find pending migrations
      const pendingMigrations = availableMigrations.filter(
        migration => !appliedMigrations.includes(migration.version)
      );

      if (pendingMigrations.length === 0) {
        logger.debug('No pending migrations to run');
        return;
      }

      logger.info(`Found ${pendingMigrations.length} pending migrations`);
      
      // Execute each pending migration
      for (const migration of pendingMigrations) {
        await this.executeMigration(migration);
      }
      
      logger.info(`Successfully applied ${pendingMigrations.length} migrations`);
    } catch (error) {
      logger.error('Migration execution failed', extractError(error));
      throw error;
    }
  }

  /**
   * Check if VSS support is available (after migration)
   */
  async hasVSSSupport(): Promise<boolean> {
    try {
      // Check if embedding columns exist
      const result = await this.connection.runAndReadAll(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'entities' 
        AND column_name = 'embedding'
      `);
      
      return result.getRows().length > 0;
    } catch (error) {
      logger.debug('VSS support check failed', extractError(error));
      return false;
    }
  }
}