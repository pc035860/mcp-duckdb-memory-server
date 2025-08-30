import {
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  MultiKeywordSearchOptions,
  SearchNodesOptions,
  TimeRangeOptions,
  DatabaseRow,
  OpenNodesOptions,
} from "../types";
import { KnowledgeGraphManagerInterface } from "./interface";
import { Logger, ConsoleLogger } from "../logger";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { extractError, convertTimestampToISOWithFallback } from "../utils";
import { ConcurrencyController, OperationType } from "../utils/concurrency-controller";
import { MigrationManager } from "../migrations/migration-manager.js";

// VSS imports
import { OpenAIEmbeddingService, createEmbeddingCache } from "../services/embedding/index.js";
import { DuckDBVSSManager } from "../services/vss/index.js";
import { HybridSearchEngine } from "../services/search/index.js";
import type { IEmbeddingService } from "../types/embedding.js";
import type { IVSSManager } from "../types/vss.js";
import type { SearchStrategy, KeywordSearchResult } from "../services/search/index.js";

// Embedding Queue imports
import { EmbeddingQueueManager } from "../services/embedding/embedding-queue-manager.js";
import type { EmbeddingQueueConfig, EmbeddingQueueCallbacks } from "../services/embedding/embedding-queue-manager.js";

/**
 * DuckDB implementation with persistent connection (no cleanup per operation)
 */
export class DuckDBKnowledgeGraphManager implements KnowledgeGraphManagerInterface {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private initialized: boolean = false;
  private dbPath: string;
  private logger: Logger;
  private closed: boolean = false;
  private allowExternalTimestamps: boolean = false;
  private entityCountThreshold: number;
  private ftsEnabled: boolean = false;
  private ftsRebuildTimer: NodeJS.Timeout | null = null;
  
  // EntityCount cache properties
  private entityCountCache: { count: number; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60000; // 1分鐘快取
  
  // Centralized concurrency controller
  private concurrencyController: ConcurrencyController;
  
  // FTS index rebuild debounce time in milliseconds
  private static readonly FTS_REBUILD_DEBOUNCE_MS = 5000;
  
  // Embedding generation (now managed by EmbeddingQueueManager)
  private embeddingQueueManager: EmbeddingQueueManager | null = null;
  private embeddingAutoGenerate: boolean = true; // configurable via env var

  // VSS services (optional, initialized on demand)
  private embeddingService: IEmbeddingService | null = null;
  private vssManager: IVSSManager | null = null;
  private hybridSearchEngine: HybridSearchEngine | null = null;

  constructor(dbPathResolver: () => string, logger?: Logger, allowExternalTimestamps: boolean = false, entityCountThreshold: number = 1000) {
    const dbPath = dbPathResolver();
    this.dbPath = dbPath;
    this.logger = logger || new ConsoleLogger();
    this.allowExternalTimestamps = allowExternalTimestamps;
    this.entityCountThreshold = entityCountThreshold;
    
    // Configure embedding auto-generation from environment variable
    this.embeddingAutoGenerate = process.env.EMBEDDING_AUTO_GENERATE !== 'false';
    
    // Initialize concurrency controller
    this.concurrencyController = new ConcurrencyController(this.logger);

    // Create directory if it doesn't exist
    const dbPathDir = dirname(dbPath);
    if (!existsSync(dbPathDir)) {
      mkdirSync(dbPathDir, { recursive: true });
    }
  }
  
  /**
   * Execute operation with concurrency control
   */
  private async executeWithConcurrencyControl<T>(
    operationType: OperationType,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.concurrencyController.execute(operationType, operation);
  }

  /**
   * Get persistent connection
   */
  private async getConnection(): Promise<DuckDBConnection> {
    if (this.closed) {
      throw new Error("Manager has been closed");
    }

    if (!this.instance || !this.connection) {
      await this.initialize();
    }

    return this.connection!;
  }

  /**
   * Initialize the database with persistent connection
   */
  async initialize(): Promise<void> {
    if (this.initialized || this.closed) return;

    try {
      // Create DuckDB instance with VSS configuration
      // Enable HNSW persistence for vector similarity search (experimental)
      const duckdbConfig: Record<string, string> = {
        hnsw_enable_experimental_persistence: 'true',
      };
      this.instance = await DuckDBInstance.create(this.dbPath, duckdbConfig);
      this.connection = await this.instance.connect();

      // Clean up any residual migration artifacts from abnormal shutdowns
      await this.cleanupStartupArtifacts();

      // Create tables if they don't exist
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS entities (
          name VARCHAR PRIMARY KEY,
          entityType VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE SEQUENCE IF NOT EXISTS observations_id_seq;
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY DEFAULT nextval('observations_id_seq'),
          entityName VARCHAR,
          content VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (entityName) REFERENCES entities(name)
        );

        CREATE TABLE IF NOT EXISTS relations (
          from_entity VARCHAR,
          to_entity VARCHAR,
          relationType VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (from_entity) REFERENCES entities(name),
          FOREIGN KEY (to_entity) REFERENCES entities(name),
          PRIMARY KEY (from_entity, to_entity, relationType)
        );

        CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entityType);
        CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entityName);
        CREATE INDEX IF NOT EXISTS idx_observations_content ON observations(content);
        CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
        CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
        CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relationType);
        
        -- Time-based indexes for efficient time range queries
        -- These indexes dramatically improve performance for time-filtered searches
        -- Expected performance improvement: 10-80x faster time range queries
        CREATE INDEX IF NOT EXISTS idx_entities_created_at ON entities(created_at);
        CREATE INDEX IF NOT EXISTS idx_observations_created_at ON observations(created_at);
        CREATE INDEX IF NOT EXISTS idx_relations_created_at ON relations(created_at);
        
        -- Composite indexes for advanced time-filtered queries
        -- Optimizes queries that filter by both type/entity and time range
        CREATE INDEX IF NOT EXISTS idx_entities_type_created_at ON entities(entityType, created_at);
        CREATE INDEX IF NOT EXISTS idx_observations_entity_created ON observations(entityName, created_at);
      `);

      // Handle migration for existing databases
      try {
        await this.connection.run(`
          ALTER TABLE entities ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
          ALTER TABLE observations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
          ALTER TABLE relations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
        `);
      } catch (alterError) {
        // Handle individual ALTER statements for older DuckDB versions
        try {
          await this.connection.run(`ALTER TABLE entities ADD COLUMN created_at TIMESTAMP;`);
        } catch (e) { 
          this.logger.debug("entities.created_at column already exists or failed to add", extractError(e));
        }
        try {
          await this.connection.run(`ALTER TABLE observations ADD COLUMN created_at TIMESTAMP;`);
        } catch (e) { 
          this.logger.debug("observations.created_at column already exists or failed to add", extractError(e));
        }
        try {
          await this.connection.run(`ALTER TABLE relations ADD COLUMN created_at TIMESTAMP;`);
        } catch (e) { 
          this.logger.debug("relations.created_at column already exists or failed to add", extractError(e));
        }
      }
      
      // Clean up any orphaned FTS schemas from previous runs or failed migrations
      await this.cleanupStaleFTSReferences();
      
      // Handle migration for observations table - add id column if it doesn't exist
      await this.migrateObservationsTable();
      
      // Run database schema migrations (including VSS support)
      const migrationManager = new MigrationManager(this.connection);
      await migrationManager.runMigrations();

      // Legacy data migration timestamp - intentionally hardcoded for consistency
      // This ensures all migrated records have the same timestamp for data integrity
      const LEGACY_MIGRATION_TIMESTAMP = '2025-07-09 00:00:00';
      
      // Update NULL values for old records with consistent migration timestamp
      await this.connection.run(`
        UPDATE entities SET created_at = '${LEGACY_MIGRATION_TIMESTAMP}'::TIMESTAMP WHERE created_at IS NULL;
        UPDATE observations SET created_at = '${LEGACY_MIGRATION_TIMESTAMP}'::TIMESTAMP WHERE created_at IS NULL;
        UPDATE relations SET created_at = '${LEGACY_MIGRATION_TIMESTAMP}'::TIMESTAMP WHERE created_at IS NULL;
      `);

      // Initialize FTS search capabilities
      await this.initializeFTS();
      
      // Initialize VSS services if available
      await this.initializeVSSServices();

      this.initialized = true;
      this.logger.info("DuckDB Manager initialized with persistent connection");
    } catch (error) {
      this.logger.error("Failed to initialize database", extractError(error));
      throw error;
    }
  }

  /**
   * Clean up residual migration artifacts and temporary tables at startup
   * 
   * This method performs comprehensive cleanup of leftover database objects from
   * failed or interrupted migrations, including:
   * - Temporary tables with suffixes _new, _backup, _temp
   * - Orphaned sequences from incomplete migrations  
   * - Recovery of data from backup tables when main tables are missing
   * 
   * The cleanup is non-fatal and will log errors but continue operation.
   * This ensures the database starts in a clean state regardless of previous
   * migration interruptions. Runs after database connection but before table creation.
   * 
   * @private
   * @async
   * @returns Promise that resolves when cleanup is complete
   */
  private async cleanupStartupArtifacts(): Promise<void> {
    if (!this.connection) return;

    try {
      this.logger.debug("Checking for residual migration artifacts...");
      
      // Check for and remove temporary tables from failed migrations
      const tempTablesResult = await this.connection.runAndReadAll(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'main' 
        AND (table_name LIKE '%_new' 
             OR table_name LIKE '%_backup' 
             OR table_name LIKE '%_temp')
      `);
      
      const tempTables = tempTablesResult.getRows();
      if (tempTables.length > 0) {
        this.logger.info(`Found ${tempTables.length} temporary table(s) to clean up`);
        
        for (const row of tempTables) {
          const tableName = row[0] as string;
          try {
            // Special handling for observations_backup - check if we need to recover data
            if (tableName === 'observations_backup') {
              // Check if observations table exists and has data
              const obsCheck = await this.connection.runAndReadAll(`
                SELECT COUNT(*) FROM information_schema.tables 
                WHERE table_schema = 'main' AND table_name = 'observations'
              `);
              
              if (obsCheck.getRows()[0][0] === 0) {
                // observations table doesn't exist, might need to recover from backup
                this.logger.warn("Found observations_backup but no observations table - attempting recovery");
                await this.connection.run(`ALTER TABLE observations_backup RENAME TO observations`);
                this.logger.info("Recovered observations table from backup");
                continue;
              }
            }
            
            // Drop the temporary table
            await this.connection.run(`DROP TABLE IF EXISTS "${tableName}"`);
            this.logger.info(`Cleaned up temporary table: ${tableName}`);
          } catch (dropError) {
            this.logger.warn(`Failed to drop temporary table ${tableName}`, extractError(dropError));
          }
        }
      } else {
        this.logger.debug("No temporary tables found");
      }
      
      // Check for orphaned sequences
      try {
        // Prefer DuckDB's native system function, fallback to PG compatibility view
        let sequencesResult;
        try {
          sequencesResult = await this.connection.runAndReadAll(`
            SELECT sequence_name 
            FROM duckdb_sequences()
            WHERE schema_name = 'main' 
              AND sequence_name LIKE '%_temp%'
          `);
        } catch (duckdbSeqErr) {
          // Fallback to pg_catalog for environments where duckdb_sequences() is unavailable
          sequencesResult = await this.connection.runAndReadAll(`
            SELECT sequencename AS sequence_name
            FROM pg_catalog.pg_sequences 
            WHERE schemaname = 'main' 
              AND sequencename LIKE '%_temp%'
          `);
        }

        const orphanedSequences = sequencesResult.getRows();
        for (const row of orphanedSequences) {
          const seqName = row[0] as string;
          try {
            await this.connection.run(`DROP SEQUENCE IF EXISTS "${seqName}"`);
            this.logger.info(`Cleaned up orphaned sequence: ${seqName}`);
          } catch (dropSeqError) {
            this.logger.warn(`Failed to drop sequence ${seqName}`, extractError(dropSeqError));
          }
        }
      } catch (seqError) {
        // Sequence cleanup is non-critical
        this.logger.debug("Sequence cleanup skipped", extractError(seqError));
      }
      
    } catch (cleanupError) {
      // Startup cleanup is non-fatal - log and continue
      this.logger.warn("Startup cleanup encountered issues but continuing", extractError(cleanupError));
    }
  }

  /**
   * Cleanup stale FTS references from orphaned or temporary tables
   * 
   * DuckDB FTS creates separate schemas (fts_main_{table_name}) for each indexed table.
   * These schemas use static table references that don't automatically update when
   * tables are renamed, dropped, or recreated during migrations.
   * 
   * This method:
   * 1. Queries all existing FTS schemas using duckdb_schemas()
   * 2. Checks if the corresponding base table still exists
   * 3. Identifies orphaned schemas from temporary tables (_new, _backup, _temp)
   * 4. Safely drops orphaned schemas with CASCADE to remove all dependencies
   * 5. Performs additional cleanup for known problematic schema patterns
   * 
   * The cleanup is essential for preventing "Table with name X does not exist"
   * errors when FTS indexes try to reference dropped or renamed tables.
   * 
   * @private
   * @async
   * @returns Promise that resolves when FTS cleanup is complete
   * @throws Non-fatal errors are logged but don't interrupt the process
   */
  private async cleanupStaleFTSReferences(): Promise<void> {
    try {
      const conn = await this.getConnection();
      
      // Query all FTS schemas
      this.logger.debug("Checking for orphaned FTS schemas...");
      
      try {
        const ftsSchemas = await conn.runAndReadAll(`
          SELECT schema_name 
          FROM duckdb_schemas() 
          WHERE schema_name LIKE 'fts_%'
        `);
        
        const schemas = ftsSchemas.getRows();
        if (schemas.length === 0) {
          this.logger.debug("No FTS schemas found");
          return;
        }
        
        this.logger.debug(`Found ${schemas.length} FTS schema(s) to check`);
        const orphanedSchemas: string[] = [];
        
        for (const row of schemas) {
          const schemaName = row[0] as string;
          
          // Extract table name from schema name
          // FTS schemas follow pattern: fts_main_{table_name}
          const match = schemaName.match(/^fts_main_(.+)$/);
          if (!match) {
            this.logger.warn(`Unexpected FTS schema name format: ${schemaName}`);
            continue;
          }
          
          const tableName = match[1];
          
          // Check if the corresponding table exists
          const tableCheck = await conn.runAndReadAll(`
            SELECT COUNT(*) as count 
            FROM information_schema.tables 
            WHERE table_schema = 'main' 
              AND table_name = ?
          `, [tableName]);
          
          const tableExists = (tableCheck.getRows()[0][0] as number) > 0;
          
          if (!tableExists) {
            this.logger.warn(`Found orphaned FTS schema '${schemaName}' for non-existent table '${tableName}'`);
            orphanedSchemas.push(schemaName);
          } else {
            // Also check for temporary table patterns that should be cleaned
            if (tableName.endsWith('_new') || tableName.endsWith('_backup') || tableName.endsWith('_temp')) {
              this.logger.warn(`Found FTS schema '${schemaName}' for temporary table '${tableName}'`);
              orphanedSchemas.push(schemaName);
            }
          }
        }
        
        // Drop orphaned schemas
        if (orphanedSchemas.length > 0) {
          this.logger.info(`Cleaning up ${orphanedSchemas.length} orphaned FTS schema(s)`);
          
          for (const schemaName of orphanedSchemas) {
            try {
              this.logger.debug(`Dropping orphaned FTS schema: ${schemaName}`);
              
              // Use CASCADE to ensure complete cleanup
              await conn.run(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
              
              this.logger.info(`Successfully dropped orphaned FTS schema: ${schemaName}`);
            } catch (dropError) {
              // Log error but continue with other schemas
              this.logger.error(`Failed to drop FTS schema '${schemaName}'`, extractError(dropError));
            }
          }
          
          this.logger.info("FTS cleanup completed");
        } else {
          this.logger.debug("No orphaned FTS schemas found");
        }
      } catch (schemaError) {
        // duckdb_schemas() might not be available in older versions
        this.logger.debug("Could not query FTS schemas, skipping dynamic cleanup", extractError(schemaError));
      }
      
      // Alternative cleanup: Try to drop known problematic FTS schemas
      const problematicSchemas = ['fts_main_observations_new', 'fts_main_observations_backup'];
      for (const schema of problematicSchemas) {
        try {
          await conn.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          this.logger.debug(`Cleaned up potentially problematic schema: ${schema}`);
        } catch (e) {
          // Schema might not exist, that's fine
        }
      }
      
    } catch (error) {
      // Cleanup errors are non-fatal, just log them
      this.logger.warn("Error during FTS cleanup", extractError(error));
    }
  }

  /**
   * Migrate observations table to add id column with proper transaction handling
   */
  private async migrateObservationsTable(): Promise<void> {
    // Use ConcurrencyController to manage migration
    await this.executeWithConcurrencyControl('migration', async () => {
      await this.performObservationsMigration();
    });
  }

  /**
   * Drop all FTS indexes to prevent references to temporary tables
   */
  /**
   * Drop all FTS indexes before database migration
   * 
   * This method is crucial for safe database migrations because DuckDB FTS
   * indexes maintain static references to table names. When tables are renamed
   * or restructured during migration, these references become invalid.
   * 
   * The method:
   * 1. Checks if FTS is enabled before attempting operations
   * 2. Iterates through main indexed tables (entities, observations)
   * 3. Uses PRAGMA drop_fts_index to cleanly remove indexes
   * 4. Continues on errors since indexes might not exist
   * 
   * After successful migration, FTS indexes should be rebuilt using
   * rebuildFTSIndexes() to restore full-text search functionality.
   * 
   * @private
   * @async
   * @param conn - Active DuckDB connection to use for operations
   * @returns Promise that resolves when all indexes are dropped
   * @throws Non-fatal errors are logged but don't interrupt migration
   */
  private async dropAllFTSIndexes(conn: DuckDBConnection): Promise<void> {
    if (!this.ftsEnabled) {
      return;
    }
    
    try {
      // Drop FTS indexes for main tables
      const tablesToDrop = ['entities', 'observations'];
      
      for (const tableName of tablesToDrop) {
        try {
          await conn.run(`PRAGMA drop_fts_index('${tableName}')`);
          this.logger.debug(`Dropped FTS index for table: ${tableName}`);
        } catch (dropError) {
          // Index might not exist, that's fine
          this.logger.debug(`FTS index for ${tableName} might not exist, continuing...`);
        }
      }
      
      this.logger.info("All FTS indexes dropped successfully");
    } catch (error) {
      this.logger.warn("Error dropping FTS indexes", extractError(error));
      // Non-critical, continue with migration
    }
  }

  /**
   * Perform the actual observations table migration
   */
  private async performObservationsMigration(): Promise<void> {
    let transactionStarted = false;
    let backupTableCreated = false;
    let ftsIndexesDropped = false;
    
    try {
      const conn = await this.getConnection();
      
      // Clean up any stale FTS references before migration
      this.logger.debug("Cleaning up stale FTS references before migration");
      await this.cleanupStaleFTSReferences();
      
      // Check if id column exists
      const result = await conn.runAndReadAll(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'observations' AND column_name = 'id'
      `);
      
      if (result.getRows().length === 0) {
        this.logger.info("Starting observations table migration to add id column");
        
        // Drop FTS indexes BEFORE starting migration to prevent references to temporary tables
        if (this.ftsEnabled) {
          this.logger.info("Dropping FTS indexes before migration to prevent orphaned references");
          await this.dropAllFTSIndexes(conn);
          ftsIndexesDropped = true;
          
          // Also clean up any stale FTS references that might exist
          await this.cleanupStaleFTSReferences();
        }
        
        // Start transaction for atomic migration
        await conn.run(`BEGIN TRANSACTION`);
        transactionStarted = true;
        this.logger.debug("Migration transaction started");
        
        // Create backup table first (for recovery if needed)
        await conn.run(`
          CREATE TABLE observations_backup AS 
          SELECT * FROM observations
        `);
        backupTableCreated = true;
        this.logger.debug("Backup table created");
        
        // Get row count for verification
        const countResult = await conn.runAndReadAll(`
          SELECT COUNT(*) as count FROM observations
        `);
        const originalCount = countResult.getRows()[0][0] as number;
        this.logger.debug(`Original observations count: ${originalCount}`);
        
        // Create sequence if it doesn't exist
        await conn.run(`
          CREATE SEQUENCE IF NOT EXISTS observations_id_seq
        `);
        
        // Create new table with id column
        await conn.run(`
          CREATE TABLE observations_new (
            id INTEGER PRIMARY KEY DEFAULT nextval('observations_id_seq'),
            entityName VARCHAR,
            content VARCHAR,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (entityName) REFERENCES entities(name)
          )
        `);
        this.logger.debug("New observations table created with id column");
        
        // Copy data from old table with explicit column mapping
        await conn.run(`
          INSERT INTO observations_new (entityName, content, created_at)
          SELECT entityName, content, 
                 COALESCE(created_at, CURRENT_TIMESTAMP) as created_at 
          FROM observations
        `);
        this.logger.debug("Data copied to new table");
        
        // Verify row count matches
        const newCountResult = await conn.runAndReadAll(`
          SELECT COUNT(*) as count FROM observations_new
        `);
        const newCount = newCountResult.getRows()[0][0] as number;
        
        if (originalCount !== newCount) {
          throw new Error(`Row count mismatch during migration: original=${originalCount}, new=${newCount}`);
        }
        this.logger.debug(`Row count verified: ${newCount} rows migrated successfully`);
        
        // Drop old table
        await conn.run(`DROP TABLE observations`);
        this.logger.debug("Old observations table dropped");
        
        // Rename new table to observations
        await conn.run(`ALTER TABLE observations_new RENAME TO observations`);
        this.logger.debug("New table renamed to observations");
        
        // Create indexes for better performance
        await conn.run(`
          CREATE INDEX IF NOT EXISTS idx_observations_entityName 
          ON observations(entityName)
        `);
        await conn.run(`
          CREATE INDEX IF NOT EXISTS idx_observations_created_at 
          ON observations(created_at)
        `);
        this.logger.debug("Indexes created on observations table");
        
        // Drop backup table after successful migration
        await conn.run(`DROP TABLE IF EXISTS observations_backup`);
        this.logger.debug("Backup table dropped after successful migration");
        
        // Commit transaction
        await conn.run(`COMMIT`);
        transactionStarted = false;
        
        this.logger.info(`Observations table migration completed successfully. Migrated ${newCount} rows.`);
        
        // Clean up any stale FTS references that might have been created during migration
        if (this.ftsEnabled) {
          this.logger.info("Cleaning up any stale FTS references after migration");
          await this.cleanupStaleFTSReferences();
          
          // Now schedule FTS index rebuild after ensuring no orphaned references exist
          this.logger.info("Scheduling FTS index rebuild after migration with extra delay");
          // Use a longer delay after migration to ensure all operations are complete
          setTimeout(async () => {
            // Double-check that migration is truly complete before rebuilding
            if (this.ftsEnabled && !this.concurrencyController.isOperationInProgress('migration')) {
              await this.scheduleIndexRebuild();
            }
          }, 2000); // 2 second delay after migration
        }
      } else {
        this.logger.debug("Observations table already has id column, skipping migration");
      }
    } catch (error) {
      this.logger.error("Error during observations table migration", extractError(error));
      
      // Rollback transaction if it was started
      if (transactionStarted) {
        try {
          this.logger.info("Rolling back migration transaction");
          const conn = await this.getConnection();
          await conn.run(`ROLLBACK`);
          this.logger.info("Migration transaction rolled back successfully");
          
          // Attempt to restore from backup if it exists
          if (backupTableCreated) {
            try {
              this.logger.info("Attempting to restore from backup table");
              
              // Check if observations table still exists
              const tableCheck = await conn.runAndReadAll(`
                SELECT COUNT(*) as count 
                FROM information_schema.tables 
                WHERE table_schema = 'main' AND table_name = 'observations'
              `);
              
              if (tableCheck.getRows()[0][0] === 0) {
                // Observations table was dropped, restore from backup
                await conn.run(`
                  ALTER TABLE observations_backup RENAME TO observations
                `);
                this.logger.info("Successfully restored observations table from backup");
              } else {
                // Clean up backup table if observations still exists
                await conn.run(`DROP TABLE IF EXISTS observations_backup`);
                this.logger.debug("Cleaned up backup table");
              }
              
              // Clean up any partial tables
              await conn.run(`DROP TABLE IF EXISTS observations_new`);
              this.logger.debug("Cleaned up partial migration tables");
              
              // Clean up any FTS references to the failed migration tables
              if (this.ftsEnabled && ftsIndexesDropped) {
                this.logger.info("Cleaning up FTS references after failed migration");
                await this.cleanupStaleFTSReferences();
                // Try to rebuild FTS indexes if tables are in good state
                try {
                  await this.rebuildFTSIndexes();
                } catch (ftsError) {
                  this.logger.warn("Failed to rebuild FTS indexes after migration rollback", extractError(ftsError));
                }
              }
            } catch (restoreError) {
              this.logger.error("Failed to restore from backup", extractError(restoreError));
              // At this point, manual intervention may be required
              throw new Error("Migration failed and automatic recovery failed. Manual intervention required.");
            }
          }
        } catch (rollbackError) {
          this.logger.error("Failed to rollback migration transaction", extractError(rollbackError));
          // If rollback fails, the database might be in an inconsistent state
          throw new Error("Critical: Migration failed and rollback failed. Database may be in inconsistent state.");
        }
      }
      
      // Log the original error but don't throw it for non-critical migrations
      // This allows the application to continue even if migration fails
      this.logger.warn("Observations migration skipped due to error. Application will continue with existing schema.");
    }
  }

  /**
   * Manual checkpoint to force WAL data to be written to disk
   */
  async checkpoint(): Promise<void> {
    try {
      const conn = await this.getConnection();
      await conn.run("CHECKPOINT");
      this.logger.info("Manual checkpoint completed successfully");
    } catch (error) {
      this.logger.error("Error during manual checkpoint", extractError(error));
      throw error;
    }
  }

  /**
   * Check if the manager is closed (getter for existing callers)
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Backward-compatible method form for older tests expecting isClosed()
   */
  public isClosedCompat(): boolean {
    return this.closed;
  }

  /**
   * Close the manager and cleanup resources
   */
  async close(): Promise<void> {
    if (this.closed) return;

    try {
      // Clear any pending FTS rebuild timer to prevent memory leaks
      if (this.ftsRebuildTimer) {
        clearTimeout(this.ftsRebuildTimer);
        this.ftsRebuildTimer = null;
        this.logger.debug("FTS rebuild timer cleared during close");
      }

      // Cleanup embedding queue manager
      if (this.embeddingQueueManager) {
        this.embeddingQueueManager.cleanup();
        this.logger.debug("EmbeddingQueueManager cleaned up during close");
      }

      if (this.connection) {
        try {
          // Try to execute CHECKPOINT to ensure data is written to disk
          // But don't fail if it errors (e.g., WAL file issues)
          await this.connection.run("CHECKPOINT");
        } catch (checkpointError) {
          // Log but don't throw - this can happen if WAL file is already removed
          this.logger.debug("Checkpoint failed during close (non-fatal)", extractError(checkpointError));
        }
        
        // node-api v1.3 之後關閉連線使用 .disconnect()
        try {
          // @ts-ignore
          if (typeof (this.connection as any).disconnect === 'function') {
            // @ts-ignore
            await (this.connection as any).disconnect();
          } else {
            (this.connection as any).close?.();
          }
        } catch {}
        this.connection = null;
      }

      this.instance = null;
      this.initialized = false;
      this.closed = true;
      
      this.logger.info("DuckDB Manager closed");
    } catch (error) {
      this.logger.error("Error during manager close", extractError(error));
      // Still mark as closed even if error occurred
      this.closed = true;
      throw error;
    }
  }

  /**
   * Get all entities from the database
   */
  private async getAllEntities(): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();

      const reader = await conn.runAndReadAll(`
        SELECT e.name, e.entityType, e.created_at, o.content
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
      `);
      const rows = reader.getRows();

      const entitiesMap = new Map<string, Entity>();

      for (const row of rows) {
        const name = row[0] as string;
        const entityType = row[1] as string;
        const created_at = row[2];
        const content = row[3] as string | null;

        if (!entitiesMap.has(name)) {
          entitiesMap.set(name, {
            name,
            entityType,
            createdAt: convertTimestampToISOWithFallback(created_at),
            observations: content ? [content] : [],
          });
        } else if (content) {
          entitiesMap.get(name)!.observations.push(content);
        }
      }

      return Array.from(entitiesMap.values());
    } catch (error: unknown) {
      this.logger.error("Error getting all entities", extractError(error));
      return [];
    }
  }

  /**
   * Create entities
   */
  async createEntities(entities: Entity[]): Promise<Entity[]> {
    // Execute bulk write with concurrency control
    return this.executeWithConcurrencyControl('bulkWrite', async () => {
      const createdEntities: Entity[] = [];
      const conn = await this.getConnection();

      try {
      await conn.run("BEGIN TRANSACTION");

      const existingEntitiesReader = await conn.runAndReadAll("SELECT name FROM entities");
      const existingEntitiesData = existingEntitiesReader.getRows();
      const existingNames = new Set(existingEntitiesData.map((row) => row[0] as string));

      const newEntities = entities.filter((entity) => !existingNames.has(entity.name));

      for (const entity of newEntities) {
        if (entity.createdAt && this.allowExternalTimestamps) {
          // If createdAt is provided and external timestamps are allowed, use it
          await conn.run("INSERT INTO entities (name, entityType, created_at) VALUES (?, ?, ?)", [
            entity.name,
            entity.entityType,
            entity.createdAt,
          ]);
        } else {
          // Otherwise, let the database use DEFAULT CURRENT_TIMESTAMP
          await conn.run("INSERT INTO entities (name, entityType) VALUES (?, ?)", [
            entity.name,
            entity.entityType,
          ]);
        }

        // Upsert into entity_embeddings if table exists (strategyC compatibility)
        try {
          const hasAux = await conn.runAndReadAll(
            "SELECT 1 FROM duckdb_tables() WHERE table_name = 'entity_embeddings' LIMIT 1"
          );
          const exists = hasAux && (Array.isArray(hasAux) ? hasAux.length > 0 : (hasAux.getRows?.().length > 0));
          if (exists) {
            await conn.run(
              `INSERT OR IGNORE INTO entity_embeddings(name, embedding, embedding_model, embedding_updated_at)
               VALUES (?, NULL, NULL, NULL)`,
              [entity.name]
            );
          }
        } catch {}

        for (const observation of entity.observations) {
          if (entity.createdAt && this.allowExternalTimestamps) {
            // Use the same timestamp for observations as the entity
            await conn.run(
              "INSERT INTO observations (entityName, content, created_at) VALUES (?, ?, ?)",
              [entity.name, observation, entity.createdAt]
            );
          } else {
            await conn.run(
              "INSERT INTO observations (entityName, content) VALUES (?, ?)",
              [entity.name, observation]
            );
          }
        }
      }

      if (newEntities.length > 0) {
        const placeholders = newEntities.map(() => "?").join(",");
        const entityNames = newEntities.map((e) => e.name);

        const reader = await conn.runAndReadAll(
          `
          SELECT e.name, e.entityType, e.created_at, o.content
          FROM entities e
          LEFT JOIN observations o ON e.name = o.entityName
          WHERE e.name IN (${placeholders})
        `,
          entityNames
        );

        const rows = reader.getRows();
        const entitiesMap = new Map<string, Entity>();

        for (const row of rows) {
          const name = row[0] as string;
          const entityType = row[1] as string;
          const created_at = row[2];
          const content = row[3] as string | null;

          if (!entitiesMap.has(name)) {
            entitiesMap.set(name, {
              name,
              entityType,
              createdAt: convertTimestampToISOWithFallback(created_at),
              observations: content ? [content] : [],
            });
          } else if (content) {
            entitiesMap.get(name)!.observations.push(content);
          }
        }

        createdEntities.push(...Array.from(entitiesMap.values()));
      }

      await conn.run("COMMIT");

      // Clear entity count cache after successful entity creation
      if (newEntities.length > 0) {
        this.clearEntityCountCache();
      }

      // Schedule FTS index rebuild after data changes
      await this.scheduleIndexRebuild();

      // Schedule embedding generation for newly created entities (non-blocking)
      if (newEntities.length > 0) {
        const entityNames = newEntities.map(e => e.name);
        this.addEntitiesToEmbeddingQueue(entityNames);
        
        // Also queue observation IDs for embedding generation
        const observationIds: number[] = [];
        for (const entity of createdEntities) {
          // Get observation IDs for the entity
          try {
            const obsReader = await conn.runAndReadAll(
              "SELECT id FROM observations WHERE entityName = ?",
              [entity.name]
            );
            const obsRows = obsReader.getRows();
            observationIds.push(...obsRows.map(row => row[0] as number));
          } catch (error) {
            this.logger.debug("Failed to get observation IDs for embedding", extractError(error));
          }
        }
        
        if (observationIds.length > 0) {
          this.addObservationsToEmbeddingQueue(observationIds);
        }
        
        // Trigger embedding generation (non-blocking)
        await this.scheduleEmbeddingGeneration();
      }

      return createdEntities;
    } catch (error: unknown) {
      await conn.run("ROLLBACK");
      this.logger.error("Error creating entities", extractError(error));
      throw error;
    }
    });
  }

  /**
   * Create relations
   */
  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const conn = await this.getConnection();

    try {
      await conn.run("BEGIN TRANSACTION");

      const entityNamesReader = await conn.runAndReadAll("SELECT name FROM entities");
      const entityNamesData = entityNamesReader.getRows();
      const entityNames = new Set(entityNamesData.map((row) => row[0] as string));

      const validRelations = relations.filter(
        (relation) => entityNames.has(relation.from) && entityNames.has(relation.to)
      );

      const existingRelationsReader = await conn.runAndReadAll(
        'SELECT from_entity as "from", to_entity as "to", relationType FROM relations'
      );
      const existingRelationsData = existingRelationsReader.getRows();

      const existingRelations = existingRelationsData.map((row) => ({
        from: row[0] as string,
        to: row[1] as string,
        relationType: row[2] as string,
      }));

      const newRelations = validRelations.filter(
        (newRel) =>
          !existingRelations.some(
            (existingRel) =>
              existingRel.from === newRel.from &&
              existingRel.to === newRel.to &&
              existingRel.relationType === newRel.relationType
          )
      );

      for (const relation of newRelations) {
        if (relation.createdAt && this.allowExternalTimestamps) {
          // If createdAt is provided and external timestamps are allowed, use it
          await conn.run(
            "INSERT INTO relations (from_entity, to_entity, relationType, created_at) VALUES (?, ?, ?, ?)",
            [relation.from, relation.to, relation.relationType, relation.createdAt]
          );
        } else {
          // Otherwise, let the database use DEFAULT CURRENT_TIMESTAMP
          await conn.run(
            "INSERT INTO relations (from_entity, to_entity, relationType) VALUES (?, ?, ?)",
            [relation.from, relation.to, relation.relationType]
          );
        }
      }

      const createdRelations: Relation[] = [];
      if (newRelations.length > 0) {
        for (const relation of newRelations) {
          const reader = await conn.runAndReadAll(
            `SELECT from_entity, to_entity, relationType, created_at 
             FROM relations 
             WHERE from_entity = ? AND to_entity = ? AND relationType = ?`,
            [relation.from, relation.to, relation.relationType]
          );
          const rows = reader.getRows();
          if (rows.length > 0) {
            const row = rows[0];
            const created_at = row[3];
            createdRelations.push({
              from: row[0] as string,
              to: row[1] as string,
              relationType: row[2] as string,
              createdAt: convertTimestampToISOWithFallback(created_at),
            });
          }
        }
      }

      await conn.run("COMMIT");
      return createdRelations;
    } catch (error: unknown) {
      await conn.run("ROLLBACK");
      this.logger.error("Error creating relations", extractError(error));
      throw error;
    }
  }

  /**
   * Add observations to entities
   */
  async addObservations(observations: Array<Observation>): Promise<Observation[]> {
    // Execute bulk write with concurrency control
    return this.executeWithConcurrencyControl('bulkWrite', async () => {
      const addedObservations: Observation[] = [];
      const conn = await this.getConnection();

      try {
      await conn.run("BEGIN TRANSACTION");

      for (const observation of observations) {
        const entityReader = await conn.runAndReadAll(
          "SELECT name FROM entities WHERE name = ?",
          [observation.entityName as string]
        );
        const entityRows = entityReader.getRows();

        if (entityRows.length > 0) {
          const existingObservationsReader = await conn.runAndReadAll(
            "SELECT content FROM observations WHERE entityName = ?",
            [observation.entityName as string]
          );
          const existingObservationsData = existingObservationsReader.getRows();
          const existingObservations = new Set(
            existingObservationsData.map((row) => row[0] as string)
          );

          const newContents = observation.contents.filter(
            (content) => !existingObservations.has(content)
          );

          if (newContents.length > 0) {
            const insertedContents: Array<{ content: string; createdAt: string }> = [];

            for (const content of newContents) {
              await conn.run(
                "INSERT INTO observations (entityName, content) VALUES (?, ?)",
                [observation.entityName, content]
              );

              const reader = await conn.runAndReadAll(
                "SELECT created_at FROM observations WHERE entityName = ? AND content = ?",
                [observation.entityName, content]
              );
              const rows = reader.getRows();
              if (rows.length > 0) {
                const created_at = rows[0][0];
                insertedContents.push({
                  content,
                  createdAt: convertTimestampToISOWithFallback(created_at),
                });
              }
            }

            if (insertedContents.length > 0) {
              const latestTimestamp = insertedContents
                .map((ic) => ic.createdAt)
                .sort()
                .pop()!;

              addedObservations.push({
                entityName: observation.entityName,
                contents: newContents,
                createdAt: latestTimestamp,
              });
            }
          }
        }
      }

      await conn.run("COMMIT");

      // Schedule FTS index rebuild after data changes
      await this.scheduleIndexRebuild();

      // Schedule embedding generation for newly added observations (non-blocking)
      if (addedObservations.length > 0) {
        const observationIds: number[] = [];
        const affectedEntityNames = new Set<string>();
        
        for (const observation of addedObservations) {
          affectedEntityNames.add(observation.entityName);
          
          // Get observation IDs for the new contents
          for (const content of observation.contents) {
            try {
              const obsReader = await conn.runAndReadAll(
                "SELECT id FROM observations WHERE entityName = ? AND content = ?",
                [observation.entityName, content]
              );
              const obsRows = obsReader.getRows();
              observationIds.push(...obsRows.map(row => row[0] as number));
            } catch (error) {
              this.logger.debug("Failed to get observation ID for embedding", extractError(error));
            }
          }
        }
        
        // Queue affected entities for re-embedding (since observations changed)
        if (affectedEntityNames.size > 0) {
          this.addEntitiesToEmbeddingQueue(Array.from(affectedEntityNames));
        }
        
        // Queue new observations for embedding
        if (observationIds.length > 0) {
          this.addObservationsToEmbeddingQueue(observationIds);
        }
        
        // Trigger embedding generation (non-blocking)
        await this.scheduleEmbeddingGeneration();
      }

      return addedObservations;
    } catch (error: unknown) {
      await conn.run("ROLLBACK");
      this.logger.error("Error adding observations", extractError(error));
      throw error;
    }
    });
  }

  /**
   * Delete entities
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    if (entityNames.length === 0) return;

    // Execute deletion with concurrency control
    return this.executeWithConcurrencyControl('deletion', async () => {
      try {
        const conn = await this.getConnection();
        const placeholders = entityNames.map(() => "?").join(",");

        // Delete related observations first
        // ERROR HANDLING STRATEGY: Non-critical cleanup operation
        // Log error but continue execution - observation cleanup failure
        // should not prevent entity deletion
        try {
          await conn.run(
            `DELETE FROM observations WHERE entityName IN (${placeholders})`,
            entityNames
          );
        } catch (error: unknown) {
          this.logger.error("Error deleting observations", extractError(error));
          // Continue execution - this is a cleanup operation
        }

        // Delete related relations
        // ERROR HANDLING STRATEGY: Non-critical cleanup operation
        // Log error but continue execution - relation cleanup failure
        // should not prevent entity deletion
        try {
          await conn.run(
            `DELETE FROM relations WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})`,
            [...entityNames, ...entityNames]
          );
        } catch (error: unknown) {
          this.logger.error("Error deleting relations", extractError(error));
          // Continue execution - this is a cleanup operation
        }

        // WORKAROUND: Drop FTS index before deleting entities to avoid observations_new error
        // This is necessary because DuckDB FTS has issues with CASCADE deletes
        // The FTS index will be recreated by scheduleIndexRebuild()
        if (this.ftsEnabled) {
          try {
            await this.safeDropFTSIndex(conn, 'observations');
            this.logger.debug("Dropped observations FTS index before entity deletion");
          } catch (dropError) {
            // Non-fatal, continue with deletion
            this.logger.debug("Could not drop observations FTS index", extractError(dropError));
          }
        }

        // Delete entities
        await conn.run(`DELETE FROM entities WHERE name IN (${placeholders})`, entityNames);

        // Clear entity count cache after successful entity deletion
        this.clearEntityCountCache();

        // Trigger an immediate, non-blocking FTS rebuild to avoid search gaps
        // Do NOT await here to prevent deadlock with concurrency controller
        if (this.ftsEnabled && !this.concurrencyController.isOperationInProgress('migration')) {
          setTimeout(() => {
            this.rebuildFTSIndexes().catch((immediateRebuildError) => {
              this.logger.warn("Immediate FTS rebuild failed after deletion, will rely on scheduled rebuild", extractError(immediateRebuildError));
              // Fallback: schedule a debounced rebuild
              this.scheduleIndexRebuild().catch(() => {/* ignore */});
            });
          }, 0);
        } else {
          // Fallback: schedule a debounced rebuild
          this.scheduleIndexRebuild().catch(() => {/* ignore */});
        }
      } catch (error: unknown) {
        this.logger.error("Error deleting entities", extractError(error));
        throw error;
      }
    });
  }

  /**
   * Delete observations from entities
   */
  async deleteObservations(deletions: Array<Observation>): Promise<void> {
    const conn = await this.getConnection();

    try {
      await conn.run("BEGIN TRANSACTION");

      for (const deletion of deletions) {
        if (deletion.contents.length > 0) {
          for (const content of deletion.contents) {
            await conn.run(
              "DELETE FROM observations WHERE entityName = ? AND content = ?",
              [deletion.entityName, content]
            );
          }
        }
      }

      await conn.run("COMMIT");

      // Schedule FTS index rebuild after data changes
      await this.scheduleIndexRebuild();
    } catch (error: unknown) {
      await conn.run("ROLLBACK");
      this.logger.error("Error deleting observations", extractError(error));
      throw error;
    }
  }

  /**
   * Delete relations
   */
  async deleteRelations(relations: Relation[]): Promise<void> {
    const conn = await this.getConnection();

    try {
      await conn.run("BEGIN TRANSACTION");

      for (const relation of relations) {
        await conn.run(
          "DELETE FROM relations WHERE from_entity = ? AND to_entity = ? AND relationType = ?",
          [relation.from, relation.to, relation.relationType]
        );
      }

      await conn.run("COMMIT");
    } catch (error: unknown) {
      await conn.run("ROLLBACK");
      this.logger.error("Error deleting relations", extractError(error));
      throw error;
    }
  }

  /**
   * Search for entities using hybrid strategy
   * - Small datasets (< 1000 entities): Use SQL LIKE search
   * - Large datasets (≥ 1000 entities): Use optimized FTS search
   */
  async searchNodes(query: string, options?: SearchNodesOptions): Promise<KnowledgeGraph> {
    try {
      if (!query || query.trim() === "") {
        return { entities: [], relations: [] };
      }

      let entities: Entity[] = [];
      
      // Extract scope and searchMode from options
      const scope = options?.scope;
      const searchMode = options?.searchMode;
      
      // Log search parameters
      this.logger.debug(`Search request: "${query}", mode: ${searchMode || 'auto'}, scope: ${scope || 'none'}, VSS available: ${this.isVSSAvailable()}`);
      
      // Use hybrid search engine if available and searchMode allows it
      // Allow Chinese queries to use VSS/hybrid as well (removed containsChinese guard)
      if (this.isVSSAvailable() && this.hybridSearchEngine && (searchMode === 'semantic' || searchMode === 'hybrid' || !searchMode)) {
        try {
          this.logger.debug(`Using hybrid search engine with mode: ${searchMode || 'auto'}`);
          const hybridResults = await this.hybridSearchEngine.searchHybrid(query, options);
          entities = hybridResults.map(result => result.entity);
        } catch (error) {
          this.logger.warn("Hybrid search failed, falling back to traditional search", extractError(error));
          entities = await this.performTraditionalSearch(query, scope, options?.timeRange);
        }
      } else {
        // Fallback to traditional search (keyword only)
        this.logger.debug(`Using traditional search (keyword only), mode: ${searchMode || 'auto'}`);
        entities = await this.performTraditionalSearch(query, scope, options?.timeRange);
      }
      

      // Deduplicate entities by name (semantic-only path may yield duplicates)
      if (entities.length > 1) {
        const byName = new Map<string, Entity>();
        for (const e of entities) {
          if (!byName.has(e.name)) byName.set(e.name, e);
        }
        entities = Array.from(byName.values());
      }

      const entityNames = entities.map((entity) => entity.name);

      if (entityNames.length === 0) {
        return { entities: [], relations: [] };
      }

      // Get related relations
      const conn = await this.getConnection();
      // If we are not including observations, fetch count per entity to keep observationsCount accurate
      const out2 = options?.output;
      const incObs2 = out2?.includeObservations ?? !out2?.compact;
      if (!incObs2) {
        const countPlaceholders = entityNames.map(() => "?").join(",");
        const countReader = await conn.runAndReadAll(
          `SELECT entityName, COUNT(*) AS cnt FROM observations WHERE entityName IN (${countPlaceholders}) GROUP BY entityName`,
          entityNames
        );
        const countRows = countReader.getRows();
        const nameToCount = new Map<string, number>();
        for (const row of countRows) {
          nameToCount.set(row[0] as string, Number(row[1]));
        }
        entities = entities.map((e) => ({
          ...e,
          observationsCount: (e as any).observationsCount ?? (nameToCount.get(e.name) || 0),
          observations: e.observations || [],
        }));
      }

      // Hydrate observations if requested (before trimming)
      const output = options?.output;
      // If observations are not included, fetch counts only to keep observationsCount accurate
      const includeObservationsFlag = output?.includeObservations ?? !output?.compact;
      if (!includeObservationsFlag && entityNames.length > 0) {
        const countPlaceholders = entityNames.map(() => "?").join(",");
        const countReader = await conn.runAndReadAll(
          `SELECT entityName, COUNT(*) AS cnt FROM observations WHERE entityName IN (${countPlaceholders}) GROUP BY entityName`,
          entityNames
        );
        const countRows = countReader.getRows();
        const nameToCount = new Map<string, number>();
        for (const row of countRows) {
          nameToCount.set(row[0] as string, Number(row[1]));
        }
        entities = entities.map((e) => ({
          ...e,
          observationsCount: (e as any).observationsCount ?? (nameToCount.get(e.name) || 0),
          observations: e.observations || [],
        }));
      }
      const includeObservations = includeObservationsFlag;
      if (includeObservationsFlag && entityNames.length > 0) {
        const obsPlaceholders = entityNames.map(() => "?").join(",");
        const obsReader = await conn.runAndReadAll(
          `SELECT entityName, content FROM observations WHERE entityName IN (${obsPlaceholders}) ORDER BY created_at`,
          entityNames
        );
        const rows = obsReader.getRows();
        const nameToObs = new Map<string, string[]>();
        for (const row of rows) {
          const name = row[0] as string;
          const content = row[1] as string;
          const list = nameToObs.get(name) || [];
          list.push(content);
          nameToObs.set(name, list);
        }
        entities = entities.map((e) => ({
          ...e,
          observations: e.observations && e.observations.length > 0 ? e.observations : (nameToObs.get(e.name) || []),
        }));
      } else if (!includeObservationsFlag && entityNames.length > 0) {
        // Not hydrating observations: fetch counts only for accurate observationsCount in previews
        const countPlaceholders = entityNames.map(() => "?").join(",");
        const countReader = await conn.runAndReadAll(
          `SELECT entityName, COUNT(*) AS cnt FROM observations WHERE entityName IN (${countPlaceholders}) GROUP BY entityName`,
          entityNames
        );
        const countRows = countReader.getRows();
        const nameToCount = new Map<string, number>();
        for (const row of countRows) {
          nameToCount.set(row[0] as string, Number(row[1]));
        }
        entities = entities.map((e) => ({
          ...e,
          observationsCount: (e as any).observationsCount ?? (nameToCount.get(e.name) || 0),
          observations: e.observations || [],
        }));
      }
      const placeholders = entityNames.map(() => "?").join(",");
      const relationsReader = await conn.runAndReadAll(
        `
        SELECT from_entity as "from", to_entity as "to", relationType, created_at
        FROM relations
        WHERE from_entity IN (${placeholders})
        OR to_entity IN (${placeholders})
        `,
        [...entityNames, ...entityNames]
      );
      const relationsData = relationsReader.getRows();

      const relations = relationsData.map((row) => {
        const created_at = row[3];
        return {
          from: row[0] as string,
          to: row[1] as string,
          relationType: row[2] as string,
          createdAt: convertTimestampToISOWithFallback(created_at),
        };
      });

      // Apply output limiting if provided
      // (note: output already read above for hydration; reusing is fine)

      // Entity limiting
      const maxEntities = output?.maxEntities && output.maxEntities > 0 ? output.maxEntities : undefined;
      const limitedEntities = maxEntities ? entities.slice(0, maxEntities) : entities;

      // Observations trimming (compact or explicitly exclude observations)
      const includeObservations2 = output?.includeObservations ?? !output?.compact;
      const maxObs = output?.maxObservationsPerEntity ?? undefined;
      const snippetChars = output?.snippetChars ?? undefined;
      const trimmedEntities = limitedEntities.map((e) => {
        const total = (typeof (e as any).observationsCount === 'number')
          ? (e as any).observationsCount as number
          : (e.observations?.length || 0);
        if (!includeObservations2) {
          return { ...e, observations: [], observationsCount: total, observationsPreview: [], omittedObservations: total };
        }
        if (!maxObs && !snippetChars) {
          // Ensure observations is always an array for consistency
          return { ...e, observations: e.observations || [], observationsCount: total };
        }
        const preview = (e.observations || [])
          .slice(0, maxObs ?? total)
          .map((t) => (snippetChars && typeof t === 'string' && t.length > snippetChars ? t.slice(0, snippetChars) : t));
        const omitted = Math.max(0, total - (maxObs ?? total));
        return { ...e, observations: preview, observationsCount: total, observationsPreview: preview, omittedObservations: omitted };
      });

      // Relations limiting per includeRelations setting
      let finalRelations = relations;
      const includeRelations = output?.includeRelations ?? 'subset';
      if (includeRelations === 'none') {
        finalRelations = [];
      } else if (includeRelations === 'subset') {
        const cap = output?.maxRelations ?? 200;
        if (finalRelations.length > cap) {
          finalRelations = finalRelations.slice(0, cap);
          this.logger.debug(
            `Relations capped for response: ${relations.length} -> ${finalRelations.length}`
          );
        }
      } // 'all' keeps full relations

      // Apply progressive truncation if maxResponseChars limit is exceeded
      const maxChars = output?.maxResponseChars ?? undefined;
      let { 
        finalEntities, 
        finalRelations: truncatedRelations, 
        wasTruncated,
        finalOmittedEntities,
        finalOmittedRelations 
      } = this.applyProgressiveTruncation(
        trimmedEntities, 
        finalRelations, 
        maxChars,
        entities.length - trimmedEntities.length,
        includeRelations === 'subset' ? Math.max(0, relations.length - finalRelations.length) : includeRelations === 'none' ? relations.length : 0
      );

      this.logger.debug(
        `Search completed: ${finalEntities.length} entities, ${truncatedRelations.length} relations${wasTruncated ? ' (truncated)' : ''}`
      );
      return {
        entities: finalEntities,
        relations: truncatedRelations,
        truncated: wasTruncated,
        omittedEntities: finalOmittedEntities,
        omittedRelations: finalOmittedRelations,
      };
    } catch (error) {
      this.logger.error("Error in searchNodes", extractError(error));
      throw error;
    }
  }

  /**
   * Search for entities using multiple keywords
   */
  async searchMultiKeywords(
    keywords: string[],
    options?: MultiKeywordSearchOptions
  ): Promise<KnowledgeGraph> {
    try {
      if (!keywords || keywords.length === 0) {
        return { entities: [], relations: [] };
      }

      const validKeywords = keywords.filter((k) => k && k.trim() !== "");
      if (validKeywords.length === 0) {
        return { entities: [], relations: [] };
      }

      // Use hybrid search strategy for better performance
      const entityCount = await this.getCachedEntityCount();
      
      let entities: Entity[] = [];
      
      if (entityCount < this.entityCountThreshold) {
        // Small dataset: use SQL LIKE search with multiple keywords
        this.logger.debug(`Using LIKE search for multi-keyword search (small dataset)${options?.scope ? ` with scope: ${options.scope}` : ''}`);
        entities = await this.searchWithMultiKeywordLike(validKeywords, options);
      } else {
        // Large dataset: use FTS search with multiple keywords
        this.logger.debug(`Using FTS search for multi-keyword search (large dataset)${options?.scope ? ` with scope: ${options.scope}` : ''}`);
        entities = await this.searchWithMultiKeywordFTS(validKeywords, options);
      }
      

      const entityNames = entities.map((entity) => entity.name);
      if (entityNames.length === 0) {
        return { entities: [], relations: [] };
      }

      // Get related relations
      const conn = await this.getConnection();
      const placeholders = entityNames.map(() => "?").join(",");
      const relationsReader = await conn.runAndReadAll(
        `
        SELECT from_entity as "from", to_entity as "to", relationType, created_at
        FROM relations
        WHERE from_entity IN (${placeholders})
        OR to_entity IN (${placeholders})
        `,
        [...entityNames, ...entityNames]
      );
      const relationsData = relationsReader.getRows();

      const relations = relationsData.map((row) => {
        const created_at = row[3];
        return {
          from: row[0] as string,
          to: row[1] as string,
          relationType: row[2] as string,
          createdAt: convertTimestampToISOWithFallback(created_at),
        };
      });

      // Apply output limiting if provided
      const output = options?.output;

      // Entity limiting
      const maxEntities = output?.maxEntities && output.maxEntities > 0 ? output.maxEntities : undefined;
      const limitedEntities = maxEntities ? entities.slice(0, maxEntities) : entities;

      // Observations trimming
      const includeObservations = output?.includeObservations ?? !output?.compact;
      const maxObs = output?.maxObservationsPerEntity ?? undefined;
      const snippetChars = output?.snippetChars ?? undefined;
      const trimmedEntities = limitedEntities.map((e) => {
        const total = (typeof (e as any).observationsCount === 'number')
          ? (e as any).observationsCount as number
          : (e.observations?.length || 0);
        if (!includeObservations) {
          return { ...e, observations: [], observationsCount: total, observationsPreview: [], omittedObservations: total };
        }
        if (!maxObs && !snippetChars) {
          return { ...e, observations: e.observations || [], observationsCount: total };
        }
        const preview = (e.observations || [])
          .slice(0, maxObs ?? total)
          .map((t) => (snippetChars && typeof t === 'string' && t.length > snippetChars ? t.slice(0, snippetChars) : t));
        const omitted = Math.max(0, total - (maxObs ?? total));
        return { ...e, observations: preview, observationsCount: total, observationsPreview: preview, omittedObservations: omitted };
      });

      // Relations limiting
      let finalRelations = relations;
      const includeRelations = output?.includeRelations ?? 'subset';
      if (includeRelations === 'none') {
        finalRelations = [];
      } else if (includeRelations === 'subset') {
        const cap = output?.maxRelations ?? 200;
        if (finalRelations.length > cap) {
          finalRelations = finalRelations.slice(0, cap);
          this.logger.debug(
            `Relations capped for response: ${relations.length} -> ${finalRelations.length}`
          );
        }
      }

      // Apply progressive truncation if maxResponseChars limit is exceeded
      const maxChars = output?.maxResponseChars ?? undefined;
      let { 
        finalEntities, 
        finalRelations: truncatedRelations, 
        wasTruncated,
        finalOmittedEntities,
        finalOmittedRelations 
      } = this.applyProgressiveTruncation(
        trimmedEntities, 
        finalRelations, 
        maxChars,
        entities.length - trimmedEntities.length,
        includeRelations === 'subset' ? Math.max(0, relations.length - finalRelations.length) : includeRelations === 'none' ? relations.length : 0
      );

      this.logger.debug(`Multi-keyword search completed: ${finalEntities.length} entities, ${truncatedRelations.length} relations${wasTruncated ? ' (truncated)' : ''}`);
      return {
        entities: finalEntities,
        relations: truncatedRelations,
        truncated: wasTruncated,
        omittedEntities: finalOmittedEntities,
        omittedRelations: finalOmittedRelations,
      };
    } catch (error) {
      this.logger.error("Error in searchMultiKeywords", extractError(error));
      throw error;
    }
  }


  /**
   * Initialize Full-Text Search capabilities
   * Creates entity_search_view for FTS operations
   */
  private async initializeFTS(): Promise<void> {
    try {
      const conn = await this.getConnection();
      
      // Step 1: Load DuckDB FTS extension
      this.logger.debug("Loading DuckDB FTS extension...");
      await conn.run("INSTALL fts");
      await conn.run("LOAD fts");
      this.logger.debug("DuckDB FTS extension loaded successfully");
      
      // Step 2: Create a view that combines entities and observations for FTS
      await conn.run(`
        CREATE OR REPLACE VIEW entity_search_view AS
        SELECT 
          e.name,
          e.entityType,
          e.created_at,
          COALESCE(
            string_agg(o.content, ' ' ORDER BY o.created_at),
            ''
          ) as observations_text
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
        GROUP BY e.name, e.entityType, e.created_at
      `);
      
      // Step 3: Check if observations table has id column before creating indexes
      let hasIdColumn = false;
      try {
        const columnCheck = await conn.runAndReadAll(`
          PRAGMA table_info(observations)
        `);
        const columns = columnCheck.getRows();
        hasIdColumn = columns.some(row => row[1] === 'id');
        
        if (!hasIdColumn) {
          this.logger.warn("Observations table does not have id column, skipping FTS index creation until migration completes");
        }
      } catch (checkError) {
        this.logger.warn("Failed to check observations table structure", extractError(checkError));
      }
      
      // Step 4: Create FTS indexes for entities and observations
      this.logger.debug("Creating FTS indexes...");
      
      // Create FTS index for entities (name only to avoid scalar subquery issues)
      await conn.run(`
        PRAGMA create_fts_index(
          'entities', 
          'name', 
          'name',
          stemmer = 'english',
          stopwords = 'english',
          lower = 1,
          strip_accents = 1,
          overwrite = 1
        )
      `);
      
      // Only create observations FTS index if id column exists
      if (hasIdColumn) {
        // Create FTS index for observations (content)
        // Using 'id' as the unique identifier column
        await conn.run(`
          PRAGMA create_fts_index(
            'observations',
            'id',
            'content',
            stemmer = 'english', 
            stopwords = 'english',
            lower = 1,
            strip_accents = 1,
            overwrite = 1
          )
        `);
        
        // Mark FTS as successfully enabled
        this.ftsEnabled = true;
        this.logger.info("DuckDB FTS initialized successfully with BM25 search capabilities");
      } else {
        // Partial FTS - only entities are indexed
        this.ftsEnabled = true;
        this.logger.info("DuckDB FTS initialized partially (entities only). Observations index will be created after migration.");  
        
        // Schedule index rebuild for later
        setTimeout(async () => {
          if (!this.concurrencyController.isOperationInProgress('migration') && this.ftsEnabled) {
            await this.scheduleIndexRebuild();
          }
        }, 5000); // Check again in 5 seconds
      }
      
    } catch (error) {
      // FTS initialization failure is non-fatal, log and continue with fallback
      this.ftsEnabled = false;
      this.logger.warn("Failed to initialize DuckDB FTS extension, falling back to LIKE search", extractError(error));
      
      // Still create the basic view for fallback search
      try {
        const conn = await this.getConnection();
        await conn.run(`
          CREATE OR REPLACE VIEW entity_search_view AS
          SELECT 
            e.name,
            e.entityType,
            e.created_at,
            COALESCE(
              string_agg(o.content, ' ' ORDER BY o.created_at),
              ''
            ) as observations_text
          FROM entities e
          LEFT JOIN observations o ON e.name = o.entityName
          GROUP BY e.name, e.entityType, e.created_at
        `);
        this.logger.debug("Fallback search view created successfully");
      } catch (viewError) {
        this.logger.error("Failed to create fallback search view", extractError(viewError));
      }
    }
  }

  /**
   * Get the total count of entities with caching for performance optimization
   * @returns Promise<number> - The total count of entities
   */
  private async getCachedEntityCount(): Promise<number> {
    const now = Date.now();
    
    // Check if cache is valid and not expired
    if (this.entityCountCache && 
        (now - this.entityCountCache.timestamp) < this.CACHE_TTL) {
      this.logger.debug(`Using cached entity count: ${this.entityCountCache.count}`);
      return this.entityCountCache.count;
    }
    
    // Cache is invalid or expired, perform actual query
    const count = await this.getEntityCount();
    
    // Update cache
    this.entityCountCache = {
      count,
      timestamp: now
    };
    
    this.logger.debug(`Updated entity count cache: ${count}`);
    return count;
  }

  /**
   * Clear the entity count cache
   * Should be called when entities are created or deleted
   */
  private clearEntityCountCache(): void {
    if (this.entityCountCache) {
      this.logger.debug("Clearing entity count cache");
      this.entityCountCache = null;
    }
  }

  /**
   * Get total entity count for search strategy decision
   */
  private async getEntityCount(): Promise<number> {
    try {
      const conn = await this.getConnection();
      const reader = await conn.runAndReadAll("SELECT COUNT(*) as count FROM entities");
      const rows = reader.getRows();
      return rows.length > 0 ? (rows[0][0] as number) : 0;
    } catch (error) {
      this.logger.error("Error getting entity count", extractError(error));
      return 0;
    }
  }

  /**
   * Search using DuckDB Full-Text Search capabilities
   */
  private async searchWithFTS(query: string, scope?: string, timeRange?: TimeRangeOptions): Promise<Entity[]> {
    try {
      // Sanitize query input
      const cleanQuery = query.trim();
      if (cleanQuery.length === 0) {
        return [];
      }

      const conn = await this.getConnection();
      
      // Use different search strategies based on FTS availability
      if (this.ftsEnabled) {
        return await this.searchWithBM25(cleanQuery, conn, scope, timeRange);
      } else {
        return await this.searchWithLikeFallback(cleanQuery, conn, scope, timeRange);
      }
      
    } catch (error) {
      this.logger.error("Error in FTS search", extractError(error));
      // Fall back to empty results rather than throwing
      return [];
    }
  }

  /**
   * Search using DuckDB FTS BM25 algorithm (when FTS is enabled)
   */
  private async searchWithBM25(query: string, conn: DuckDBConnection, scope?: string, timeRange?: TimeRangeOptions): Promise<Entity[]> {
    try {
      const entities: Entity[] = [];
      const entityScores = new Map<string, number>();

      // Build scope filter if provided
      let scopeCondition = '';
      const entityParams: any[] = [query];
      
      if (scope) {
        // Support both "project:" and "[project]:" formats with case insensitive matching
        const cleanScope = scope.replace(/[\[\]]/g, '');
        scopeCondition = 'AND (name ILIKE ? OR name ILIKE ?)';
        entityParams.push(`${cleanScope}:%`, `[${cleanScope}]:%`);
      }
      
      // Build time range filter if provided
      let timeCondition = '';
      if (timeRange) {
        // For entities query in BM25, we want to filter by entity creation time only
        const entityOnlyTimeRange = { ...timeRange, timeScope: 'entities' as const };
        const timeFilter = this.buildTimeCondition(entityOnlyTimeRange);
        if (timeFilter.condition) {
          timeCondition = `AND (${timeFilter.condition})`;
          entityParams.push(...timeFilter.params);
        }
      }
      
      // Search in entities table using BM25 and fetch observations in one query
      // Use CTE to avoid scalar subquery errors when match_bm25 is used in WHERE clause
      const entityReader = await conn.runAndReadAll(`
        WITH scored_entities AS (
          SELECT name, entityType, created_at, 
                 fts_main_entities.match_bm25(name, ?) AS score
          FROM entities e
          WHERE 1=1 ${scopeCondition} ${timeCondition}
        ),
        entity_observations AS (
          SELECT entityName, 
                 string_agg(content, '|||' ORDER BY created_at) as observations_concat
          FROM observations
          GROUP BY entityName
        )
        SELECT se.name, se.entityType, se.created_at, se.score,
               COALESCE(eo.observations_concat, '') as observations_concat
        FROM scored_entities se
        LEFT JOIN entity_observations eo ON se.name = eo.entityName
        WHERE se.score IS NOT NULL
        ORDER BY se.score DESC
        LIMIT 250
      `, entityParams);

      const entityRows = entityReader.getRows();
      for (const row of entityRows) {
        const name = row[0] as string;
        const entityType = row[1] as string;
        const created_at = row[2];
        const score = row[3] as number;
        const observationsConcat = row[4] as string | null;
        
        entityScores.set(name, score);
        
        // Parse observations from concatenated string
        const observations = observationsConcat && observationsConcat.trim() !== '' ? observationsConcat.split('|||') : [];
        
        entities.push({
          name,
          entityType,
          createdAt: convertTimestampToISOWithFallback(created_at),
          observations
        });
      }

      // Search in observations table using BM25
      // Use CTE to avoid scalar subquery errors when match_bm25 is used in WHERE clause
      // Use MAX() to aggregate scores when an entity has multiple matching observations
      this.logger.debug(`Searching observations for query: "${query}"`);
      const obsParams: any[] = [query];
      let obsJoinCondition = '';
      
      if (scope || timeRange) {
        const conditions: string[] = [];
        
        if (scope) {
          // Join with entities table to apply scope filter
          const cleanScope = scope.replace(/[\[\]]/g, '');
          conditions.push('(e.name ILIKE ? OR e.name ILIKE ?)');
          obsParams.push(`${cleanScope}:%`, `[${cleanScope}]:%`);
        }
        
        if (timeRange) {
          // For observations query in BM25, we want to filter by observation creation time only
          const obsOnlyTimeRange = { ...timeRange, timeScope: 'observations' as const };
          const timeFilter = this.buildTimeCondition(obsOnlyTimeRange);
          if (timeFilter.condition) {
            conditions.push(timeFilter.condition);
            obsParams.push(...timeFilter.params);
          }
        }
        
        if (conditions.length > 0) {
          obsJoinCondition = `
            JOIN entities e ON o.entityName = e.name
            WHERE ${conditions.join(' AND ')}
          `;
        }
      }
      
      const obsQuery = `
        WITH scored_observations AS (
          SELECT o.entityName, 
                 fts_main_observations.match_bm25(o.id, ?) AS score
          FROM observations o
          ${obsJoinCondition}
        ),
        max_scored_entities AS (
          SELECT entityName, MAX(score) AS score
          FROM scored_observations
          WHERE score IS NOT NULL
          GROUP BY entityName
        ),
        entity_observations AS (
          SELECT entityName, 
                 string_agg(content, '|||' ORDER BY created_at) as observations_concat
          FROM observations
          GROUP BY entityName
        )
        SELECT mse.entityName, mse.score,
               e.name, e.entityType, e.created_at,
               COALESCE(eo.observations_concat, '') as observations_concat
        FROM max_scored_entities mse
        JOIN entities e ON mse.entityName = e.name
        LEFT JOIN entity_observations eo ON e.name = eo.entityName
        ORDER BY mse.score DESC
        LIMIT 250
      `;
      this.logger.debug(`Observations BM25 query: ${obsQuery}`);
      this.logger.debug(`Observations query params: ${JSON.stringify(obsParams)}`);
      
      const obsReader = await conn.runAndReadAll(obsQuery, obsParams);

      const obsRows = obsReader.getRows();
      this.logger.debug(`Observations BM25 search returned ${obsRows.length} results`);
      
      for (const row of obsRows) {
        const entityName = row[0] as string;
        const obsScore = row[1] as number;
        const name = row[2] as string;
        const entityType = row[3] as string;
        const created_at = row[4];
        const observationsConcat = row[5] as string | null;
        
        // Skip if we already have this entity with a better score
        if (entityScores.has(entityName) && entityScores.get(entityName)! >= obsScore) {
          continue;
        }
        
        // Parse observations from concatenated string
        const observations = observationsConcat && observationsConcat.trim() !== '' ? observationsConcat.split('|||') : [];
        
        entities.push({
          name,
          entityType,
          createdAt: convertTimestampToISOWithFallback(created_at),
          observations
        });
        
        entityScores.set(name, obsScore);
      }

      // Remove duplicates and sort by best score
      const uniqueEntities = Array.from(
        new Map(entities.map(e => [e.name, e])).values()
      ).sort((a, b) => (entityScores.get(b.name) || 0) - (entityScores.get(a.name) || 0));

      this.logger.debug(`BM25 FTS search for "${query}" returned ${uniqueEntities.length} entities`);
      return uniqueEntities.slice(0, 100); // Limit final results

    } catch (error) {
      this.logger.warn("BM25 search failed, falling back to LIKE search", extractError(error));
      return await this.searchWithLikeFallback(query, conn, scope, timeRange);
    }
  }


  /**
   * Safely drop FTS index with fallback strategies
   */
  /**
   * Safely drop an FTS index using multiple fallback strategies
   * 
   * This method implements a defensive three-tier approach to FTS index removal:
   * 
   * Tier 1: PRAGMA drop_fts_index - The standard DuckDB method
   * - Cleanly removes the FTS index and associated schema
   * - Preferred method when the index exists and is healthy
   * 
   * Tier 2: Direct schema drop with CASCADE
   * - Drops the entire FTS schema (fts_main_{table_name})
   * - Used when PRAGMA fails due to corrupted index state
   * - CASCADE ensures all dependent objects are removed
   * 
   * Tier 3: Silent continuation
   * - If both methods fail, assumes index doesn't exist
   * - Logs the attempt but doesn't fail the operation
   * 
   * This multi-tier approach ensures robustness against various FTS corruption
   * scenarios that can occur during migrations or system interruptions.
   * 
   * @private
   * @async
   * @param conn - Active DuckDB connection for the operation
   * @param tableName - Name of the table whose FTS index should be dropped
   * @returns Promise that resolves when drop attempt is complete
   */
  private async safeDropFTSIndex(conn: DuckDBConnection, tableName: string): Promise<void> {
    const schemaName = `fts_main_${tableName}`;
    
    try {
      // First attempt: Use PRAGMA drop_fts_index
      await conn.run(`PRAGMA drop_fts_index('${tableName}')`);
      this.logger.debug(`Successfully dropped FTS index for ${tableName} using PRAGMA`);
      return;
    } catch (pragmaError) {
      this.logger.debug(`PRAGMA drop_fts_index failed for ${tableName}, trying schema drop...`, extractError(pragmaError));
    }
    
    try {
      // Second attempt: Drop the FTS schema directly
      await conn.run(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      this.logger.debug(`Successfully dropped FTS schema ${schemaName} directly`);
      return;
    } catch (schemaError) {
      this.logger.debug(`Direct schema drop failed for ${schemaName}`, extractError(schemaError));
    }
    
    // If both methods fail, log but continue
    this.logger.debug(`Could not drop FTS index/schema for ${tableName}, it might not exist`);
  }

  /**
   * Rebuild FTS indexes (useful for maintenance or after bulk data changes)
   * Now with improved error handling and self-healing capabilities
   */
  async rebuildFTSIndexes(): Promise<void> {
    if (!this.ftsEnabled) {
      this.logger.warn("FTS not enabled, skipping index rebuild");
      return;
    }

    // Skip if migration is in progress
    if (this.concurrencyController.isOperationInProgress('migration')) {
      this.logger.warn("Migration in progress, skipping FTS index rebuild");
      return;
    }

    // Execute FTS rebuild with concurrency control
    return this.executeWithConcurrencyControl('ftsRebuild', async () => {
      const conn = await this.getConnection();
      
      // Step 1: Clean up any stale FTS references BEFORE attempting to drop indexes
      await this.cleanupStaleFTSReferences();
      
      // Step 2: Verify that the tables exist and are not temporary migration tables
      let tablesReady = false;
      let hasIdColumn = false;
      
      try {
        const tableCheck = await conn.runAndReadAll(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'main'
          AND table_name IN ('entities', 'observations')
          AND table_name NOT LIKE '%_new'
          AND table_name NOT LIKE '%_backup'
          AND table_name NOT LIKE '%_temp'
        `);
        
        const tables = tableCheck.getRows().map(row => row[0] as string);
        tablesReady = tables.includes('entities') && tables.includes('observations');
        
        if (!tablesReady) {
          this.logger.warn(`Required tables not found for FTS indexing. Found tables: ${tables.join(', ')}`);
          return;
        }
        
        // Also check for any temporary tables that might interfere
        const tempTableCheck = await conn.runAndReadAll(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'main'
          AND (table_name LIKE 'observations_new' 
               OR table_name LIKE 'observations_backup'
               OR table_name LIKE 'observations_temp'
               OR table_name LIKE 'entities_new'
               OR table_name LIKE 'entities_backup'
               OR table_name LIKE 'entities_temp')
        `);
        
        const tempTables = tempTableCheck.getRows().map(row => row[0] as string);
        if (tempTables.length > 0) {
          this.logger.warn(`Found temporary tables that might interfere with FTS indexing: ${tempTables.join(', ')}. Aborting FTS rebuild.`);
          // Clean up FTS references to these temporary tables
          await this.cleanupStaleFTSReferences();
          return;
        }
        
        // Check if the observations table has the id column
        const columnCheck = await conn.runAndReadAll(`
          PRAGMA table_info(observations)
        `);
        const columns = columnCheck.getRows();
        hasIdColumn = columns.some(row => row[1] === 'id');
        
        if (!hasIdColumn) {
          this.logger.warn("Observations table does not have id column, skipping observations FTS index");
        }
      } catch (checkError) {
        this.logger.error("Failed to verify table structure for FTS indexing", extractError(checkError));
        return;
      }
      
      this.logger.info("Rebuilding FTS indexes...");
      
      // Step 3: Drop existing indexes with improved error handling
      // Each table's FTS operations are wrapped in separate try-catch
      
      // Handle entities table FTS
      try {
        await this.safeDropFTSIndex(conn, 'entities');
        
        // Recreate entities index
        await conn.run(`
          PRAGMA create_fts_index(
            'entities', 
            'name', 
            'name',
            stemmer = 'english',
            stopwords = 'english',
            lower = 1,
            strip_accents = 1,
            overwrite = 1
          )
        `);
        this.logger.info("Entities FTS index rebuilt successfully");
      } catch (entitiesError) {
        this.logger.error("Failed to rebuild entities FTS index", extractError(entitiesError));
        // Continue with observations even if entities fails
      }
      
      // Handle observations table FTS (only if it has id column)
      if (hasIdColumn) {
        try {
          await this.safeDropFTSIndex(conn, 'observations');
          
          // Recreate observations index
          await conn.run(`
            PRAGMA create_fts_index(
              'observations',
              'id',
              'content',
              stemmer = 'english', 
              stopwords = 'english',
              lower = 1,
              strip_accents = 1,
              overwrite = 1
            )
          `);
          this.logger.info("Observations FTS index rebuilt successfully");
        } catch (observationsError) {
          this.logger.error("Failed to rebuild observations FTS index", extractError(observationsError));
          // Non-fatal, search will fall back to LIKE queries
        }
      }
      
      this.logger.info("FTS index rebuild process completed");
    });
  }

  /**
   * Check FTS index health and status
   */
  async checkFTSIndexHealth(): Promise<{ 
    ftsEnabled: boolean; 
    entitiesIndexed: number; 
    observationsIndexed: number; 
    status: string 
  }> {
    try {
      const conn = await this.getConnection();
      const result = {
        ftsEnabled: this.ftsEnabled,
        entitiesIndexed: 0,
        observationsIndexed: 0,
        status: 'unknown'
      };

      if (!this.ftsEnabled) {
        result.status = 'FTS not enabled, using fallback search';
        return result;
      }

      try {
        // Check entities index
        const entitiesCountReader = await conn.runAndReadAll(
          "SELECT COUNT(*) as count FROM entities"
        );
        const entitiesCount = entitiesCountReader.getRows()[0][0] as number;
        result.entitiesIndexed = entitiesCount;

        // Check observations index
        const obsCountReader = await conn.runAndReadAll(
          "SELECT COUNT(*) as count FROM observations"
        );
        const obsCount = obsCountReader.getRows()[0][0] as number;
        result.observationsIndexed = obsCount;

        // Test FTS functionality with a simple query
        // Use CTE to avoid scalar subquery errors when match_bm25 is used in WHERE clause
        await conn.runAndReadAll(`
          WITH scored_entities AS (
            SELECT name, fts_main_entities.match_bm25(name, 'test') AS score
            FROM entities
          )
          SELECT name, score
          FROM scored_entities
          WHERE score IS NOT NULL
          LIMIT 1
        `);

        result.status = 'healthy';
        this.logger.debug(`FTS health check: ${result.entitiesIndexed} entities, ${result.observationsIndexed} observations indexed`);

      } catch (testError) {
        result.status = 'degraded - FTS queries failing';
        this.logger.warn("FTS health check failed, indexes may be corrupted", extractError(testError));
      }

      return result;

    } catch (error) {
      this.logger.error("FTS health check failed", extractError(error));
      return {
        ftsEnabled: false,
        entitiesIndexed: 0,
        observationsIndexed: 0,
        status: 'failed'
      };
    }
  }

  /**
   * Get FTS configuration and statistics
   */
  async getFTSInfo(): Promise<{
    enabled: boolean;
    extensionLoaded: boolean;
    searchStrategy: string;
    indexCount: number;
  }> {
    // Check if manager is closed
    if (this.closed) {
      throw new Error("Manager has been closed");
    }

    try {
      const conn = await this.getConnection();
      
      // Determine if FTS will actually be used based on current entity count
      const entityCount = await this.getCachedEntityCount();
      const willUseFTS = this.ftsEnabled && entityCount >= this.entityCountThreshold;
      
      const info = {
        enabled: willUseFTS,
        extensionLoaded: false,
        searchStrategy: willUseFTS ? 'BM25' : 'ILIKE',
        indexCount: 0
      };

      // Check if FTS extension is loaded
      try {
        await conn.runAndReadAll("SELECT fts_main_entities.match_bm25('test', 'test')");
        info.extensionLoaded = true;
      } catch {
        info.extensionLoaded = false;
      }

      // Count available indexes (simplified check)
      if (this.ftsEnabled) {
        info.indexCount = 2; // entities + observations
      }

      return info;

    } catch (error) {
      this.logger.error("Failed to get FTS info", extractError(error));
      return {
        enabled: false,
        extensionLoaded: false,
        searchStrategy: 'ILIKE',
        indexCount: 0
      };
    }
  }

  /**
   * Manually trigger cleanup of orphaned FTS schemas
   * This is useful for maintenance or after failed migrations
   * @returns Promise<{ cleaned: number; schemas: string[] }> - Information about cleaned schemas
   */
  async cleanupOrphanedFTSSchemas(): Promise<{ cleaned: number; schemas: string[] }> {
    // Check if manager is closed
    if (this.closed) {
      throw new Error("Manager has been closed");
    }

    const cleanedSchemas: string[] = [];
    
    try {
      const conn = await this.getConnection();
      
      // Query all FTS schemas
      this.logger.info("Starting manual FTS cleanup...");
      const ftsSchemas = await conn.runAndReadAll(`
        SELECT schema_name 
        FROM duckdb_schemas() 
        WHERE schema_name LIKE 'fts_%'
      `);
      
      const schemas = ftsSchemas.getRows();
      if (schemas.length === 0) {
        this.logger.info("No FTS schemas found during manual cleanup");
        return { cleaned: 0, schemas: [] };
      }
      
      this.logger.info(`Found ${schemas.length} FTS schema(s) to check during manual cleanup`);
      
      for (const row of schemas) {
        const schemaName = row[0] as string;
        
        // Extract table name from schema name
        const match = schemaName.match(/^fts_main_(.+)$/);
        if (!match) {
          this.logger.warn(`Unexpected FTS schema name format during cleanup: ${schemaName}`);
          continue;
        }
        
        const tableName = match[1];
        
        // Check if the corresponding table exists
        const tableCheck = await conn.runAndReadAll(`
          SELECT COUNT(*) as count 
          FROM information_schema.tables 
          WHERE table_schema = 'main' 
            AND table_name = '${tableName}'
        `);
        
        const rows = tableCheck.getRows();
        const tableExists = rows.length > 0 && (rows[0][0] as number) > 0;
        
        // Determine if this schema should be cleaned
        let shouldClean = false;
        
        if (!tableExists) {
          this.logger.warn(`Found orphaned FTS schema '${schemaName}' for non-existent table '${tableName}'`);
          shouldClean = true;
        } else if (tableName.endsWith('_new') || tableName.endsWith('_backup') || tableName.endsWith('_temp')) {
          this.logger.warn(`Found FTS schema '${schemaName}' for temporary table '${tableName}'`);
          shouldClean = true;
        }
        
        if (shouldClean) {
          try {
            this.logger.info(`Dropping orphaned FTS schema: ${schemaName}`);
            await conn.run(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
            cleanedSchemas.push(schemaName);
            this.logger.info(`Successfully dropped orphaned FTS schema: ${schemaName}`);
          } catch (dropError) {
            this.logger.error(`Failed to drop FTS schema '${schemaName}'`, extractError(dropError));
          }
        }
      }
      
      if (cleanedSchemas.length > 0) {
        this.logger.info(`Manual FTS cleanup completed. Cleaned ${cleanedSchemas.length} schema(s)`);
      } else {
        this.logger.info("Manual FTS cleanup completed. No orphaned schemas found.");
      }
      
      return { cleaned: cleanedSchemas.length, schemas: cleanedSchemas };
      
    } catch (error) {
      this.logger.error("Error during manual FTS cleanup", extractError(error));
      throw error;
    }
  }

  /**
   * Fallback search using ILIKE when FTS is not available
   */
  private async searchWithLikeFallback(query: string, conn: DuckDBConnection, scope?: string, timeRange?: TimeRangeOptions): Promise<Entity[]> {
    // Split query into search terms for more precise matching
    const searchTerms = query.split(/\s+/).filter(term => term.length > 0);
    
    if (searchTerms.length === 0) {
      return [];
    }
    
    // Build dynamic WHERE clause for multiple search terms
    const whereConditions = searchTerms.map(() => 
      "(name ILIKE ? OR entityType ILIKE ? OR observations_text ILIKE ?)"
    ).join(" AND ");
    
    // Prepare parameters (each term used 3 times for name, entityType, observations)
    const params = searchTerms.flatMap(term => {
      const likePattern = `%${term}%`;
      return [likePattern, likePattern, likePattern];
    });
    
    // Add scope filter if provided
    let scopeCondition = '';
    if (scope) {
      const cleanScope = scope.replace(/[\[\]]/g, '');
      scopeCondition = ' AND (name ILIKE ? OR name ILIKE ?)';
      params.push(`${cleanScope}:%`, `[${cleanScope}]:%`);
    }
    
    // Add time range filter if provided
    let timeCondition = '';
    if (timeRange) {
      const timeFilter = this.buildTimeCondition(timeRange);
      if (timeFilter.condition) {
        // For entity_search_view, we only care about entity timestamps
        const entityTimeConditions = timeFilter.condition
          .split(' AND ')
          .filter(cond => cond.includes('e.created_at'))
          .map(cond => cond.replace('e.created_at', 'created_at')) // Replace e.created_at with created_at for the view
          .join(' AND ');
        
        if (entityTimeConditions) {
          timeCondition = ` AND (${entityTimeConditions})`;
          // Add corresponding parameters for entity time conditions (only for absolute time filters)
          const conditionParts = timeFilter.condition.split(' AND ');
          const entityTimeParams: any[] = [];
          
          conditionParts.forEach((cond, index) => {
            if (cond.includes('e.created_at') && index < timeFilter.params.length) {
              entityTimeParams.push(timeFilter.params[index]);
            }
          });
          
          params.push(...entityTimeParams);
        }
      }
    }
    
    const reader = await conn.runAndReadAll(`
      SELECT DISTINCT name, entityType, created_at
      FROM entity_search_view
      WHERE ${whereConditions}${scopeCondition}${timeCondition}
      ORDER BY 
        -- Prioritize exact name matches
        CASE WHEN name ILIKE ? THEN 1
             WHEN entityType ILIKE ? THEN 2
             ELSE 3 END,
        created_at DESC
      LIMIT 100
    `, [...params, `%${query}%`, `%${query}%`]);
    
    const rows = reader.getRows();
    const entities: Entity[] = [];
    
    for (const row of rows) {
      const name = row[0] as string;
      const entityType = row[1] as string;
      const created_at = row[2];
      
      // Get observations for this entity
      const obsReader = await conn.runAndReadAll(
        "SELECT content FROM observations WHERE entityName = ? ORDER BY created_at",
        [name]
      );
      const obsRows = obsReader.getRows();
      const observations = obsRows.map(obsRow => obsRow[0] as string);
      
      entities.push({
        name,
        entityType,
        createdAt: convertTimestampToISOWithFallback(created_at),
        observations
      });
    }
    
    this.logger.debug(`Fallback LIKE search for "${query}" returned ${entities.length} entities`);
    return entities;
  }

  /**
   * Build time condition SQL clause and parameters for filtering
   * @param timeRange - Time range options
   * @returns Object containing SQL condition string and parameters array
   */
  private buildTimeCondition(timeRange: TimeRangeOptions): { condition: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];
    
    const timeScope = timeRange.timeScope || 'any';
    
    // Handle absolute time ranges
    if (timeRange.createdAfter) {
      try {
        // Convert ISO 8601 to DuckDB TIMESTAMP format
        const afterTimestamp = new Date(timeRange.createdAfter).toISOString();
        const scopeConditions: string[] = [];
        
        if (timeScope === 'entities') {
          scopeConditions.push('e.created_at >= ?::TIMESTAMP');
          params.push(afterTimestamp);
        } else if (timeScope === 'observations') {
          scopeConditions.push('o.created_at >= ?::TIMESTAMP');
          params.push(afterTimestamp);
        } else if (timeScope === 'relations') {
          scopeConditions.push('r.created_at >= ?::TIMESTAMP');
          params.push(afterTimestamp);
        } else { // 'any' - use OR logic for entities and observations
          scopeConditions.push('e.created_at >= ?::TIMESTAMP');
          params.push(afterTimestamp);
          scopeConditions.push('o.created_at >= ?::TIMESTAMP');
          params.push(afterTimestamp);
        }
        
        if (scopeConditions.length > 0) {
          if (timeScope === 'any' && scopeConditions.length > 1) {
            conditions.push(`(${scopeConditions.join(' OR ')})`);
          } else {
            conditions.push(...scopeConditions);
          }
        }
        
        this.logger.debug(`Applied createdAfter filter: ${afterTimestamp} for scope: ${timeScope}`);
      } catch (error) {
        this.logger.warn(`Invalid createdAfter date format: ${timeRange.createdAfter}`, extractError(error));
      }
    }
    
    if (timeRange.createdBefore) {
      try {
        // Convert ISO 8601 to DuckDB TIMESTAMP format
        const beforeTimestamp = new Date(timeRange.createdBefore).toISOString();
        const scopeConditions: string[] = [];
        
        if (timeScope === 'entities') {
          scopeConditions.push('e.created_at <= ?::TIMESTAMP');
          params.push(beforeTimestamp);
        } else if (timeScope === 'observations') {
          scopeConditions.push('o.created_at <= ?::TIMESTAMP');
          params.push(beforeTimestamp);
        } else if (timeScope === 'relations') {
          scopeConditions.push('r.created_at <= ?::TIMESTAMP');
          params.push(beforeTimestamp);
        } else { // 'any' - use OR logic for entities and observations
          scopeConditions.push('e.created_at <= ?::TIMESTAMP');
          params.push(beforeTimestamp);
          scopeConditions.push('o.created_at <= ?::TIMESTAMP');
          params.push(beforeTimestamp);
        }
        
        if (scopeConditions.length > 0) {
          if (timeScope === 'any' && scopeConditions.length > 1) {
            conditions.push(`(${scopeConditions.join(' OR ')})`);
          } else {
            conditions.push(...scopeConditions);
          }
        }
        
        this.logger.debug(`Applied createdBefore filter: ${beforeTimestamp} for scope: ${timeScope}`);
      } catch (error) {
        this.logger.warn(`Invalid createdBefore date format: ${timeRange.createdBefore}`, extractError(error));
      }
    }
    
    // Handle relative time ranges
    if (timeRange.lastDays && timeRange.lastDays > 0) {
      const scopeConditions: string[] = [];
      
      const cutoffTime = new Date(Date.now() - timeRange.lastDays * 24 * 60 * 60 * 1000).toISOString();
      
      if (timeScope === 'entities') {
        scopeConditions.push(`e.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else if (timeScope === 'observations') {
        scopeConditions.push(`o.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else if (timeScope === 'relations') {
        scopeConditions.push(`r.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else { // 'any' - use OR logic for entities and observations
        scopeConditions.push(`e.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
        scopeConditions.push(`o.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      }
      
      if (scopeConditions.length > 0) {
        if (timeScope === 'any' && scopeConditions.length > 1) {
          conditions.push(`(${scopeConditions.join(' OR ')})`);
        } else {
          conditions.push(...scopeConditions);
        }
      }
      
      this.logger.debug(`Applied lastDays filter: ${timeRange.lastDays} days for scope: ${timeScope}`);
    }
    
    if (timeRange.lastHours && timeRange.lastHours > 0) {
      const scopeConditions: string[] = [];
      
      const cutoffTime = new Date(Date.now() - timeRange.lastHours * 60 * 60 * 1000).toISOString();
      
      if (timeScope === 'entities') {
        scopeConditions.push(`e.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else if (timeScope === 'observations') {
        scopeConditions.push(`o.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else if (timeScope === 'relations') {
        scopeConditions.push(`r.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else { // 'any' - use OR logic for entities and observations
        scopeConditions.push(`e.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
        scopeConditions.push(`o.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      }
      
      if (scopeConditions.length > 0) {
        if (timeScope === 'any' && scopeConditions.length > 1) {
          conditions.push(`(${scopeConditions.join(' OR ')})`);
        } else {
          conditions.push(...scopeConditions);
        }
      }
      
      this.logger.debug(`Applied lastHours filter: ${timeRange.lastHours} hours for scope: ${timeScope}`);
    }
    
    if (timeRange.lastMinutes && timeRange.lastMinutes > 0) {
      const scopeConditions: string[] = [];
      
      const cutoffTime = new Date(Date.now() - timeRange.lastMinutes * 60 * 1000).toISOString();
      
      if (timeScope === 'entities') {
        scopeConditions.push(`e.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else if (timeScope === 'observations') {
        scopeConditions.push(`o.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else if (timeScope === 'relations') {
        scopeConditions.push(`r.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      } else { // 'any' - use OR logic for entities and observations
        scopeConditions.push(`e.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
        scopeConditions.push(`o.created_at >= ?::TIMESTAMP`);
        params.push(cutoffTime);
      }
      
      if (scopeConditions.length > 0) {
        if (timeScope === 'any' && scopeConditions.length > 1) {
          conditions.push(`(${scopeConditions.join(' OR ')})`);
        } else {
          conditions.push(...scopeConditions);
        }
      }
      
      this.logger.debug(`Applied lastMinutes filter: ${timeRange.lastMinutes} minutes for scope: ${timeScope}`);
    }
    
    // Combine conditions with AND logic
    const condition = conditions.length > 0 ? conditions.join(' AND ') : '';
    
    this.logger.debug(`Built time condition: ${condition} with ${params.length} parameters`);
    
    return { condition, params };
  }

  /**
   * Apply progressive truncation to response when it exceeds maxResponseChars
   * Strategy: 1) Remove observations, 2) Reduce relations, 3) Reduce entities (min 5)
   */
  private applyProgressiveTruncation(
    entities: Entity[],
    relations: any[],
    maxChars?: number,
    initialOmittedEntities: number = 0,
    initialOmittedRelations: number = 0
  ): {
    finalEntities: Entity[];
    finalRelations: any[];
    wasTruncated: boolean;
    finalOmittedEntities: number;
    finalOmittedRelations: number;
  } {
    // If no size limit, return as-is
    if (!maxChars || maxChars <= 0) {
      return {
        finalEntities: entities,
        finalRelations: relations,
        wasTruncated: false,
        finalOmittedEntities: initialOmittedEntities,
        finalOmittedRelations: initialOmittedRelations,
      };
    }

    let currentEntities = [...entities];
    let currentRelations = [...relations];
    let wasTruncated = false;
    let currentOmittedEntities = initialOmittedEntities;
    let currentOmittedRelations = initialOmittedRelations;

    // Helper function to calculate current response size
    const getCurrentSize = () => {
      return JSON.stringify({ entities: currentEntities, relations: currentRelations }).length;
    };

    // Check if we need to truncate
    if (getCurrentSize() <= maxChars) {
      return {
        finalEntities: currentEntities,
        finalRelations: currentRelations,
        wasTruncated: false,
        finalOmittedEntities: currentOmittedEntities,
        finalOmittedRelations: currentOmittedRelations,
      };
    }

    wasTruncated = true;
    this.logger.debug(`Response size ${getCurrentSize()} exceeds limit ${maxChars}, applying progressive truncation`);

    // Step 1: Remove all observations, keep only observationsPreview
    const entitiesWithoutObservations = currentEntities.map(entity => {
      const totalObs = entity.observations?.length || 0;
      if (totalObs > 0) {
        const { observations, ...entityWithoutObs } = entity;
        return {
          ...entityWithoutObs,
          observations: [],
          observationsCount: totalObs,
          observationsPreview: entity.observationsPreview || [],
          omittedObservations: totalObs,
        };
      }
      return entity;
    });

    currentEntities = entitiesWithoutObservations;
    this.logger.debug(`After removing observations: ${getCurrentSize()} chars`);

    // If still too large, Step 2: Reduce relations
    if (getCurrentSize() > maxChars && currentRelations.length > 0) {
      const targetRelations = Math.max(0, Math.floor(currentRelations.length * 0.5));
      const originalRelationsCount = currentRelations.length + currentOmittedRelations;
      currentRelations = currentRelations.slice(0, targetRelations);
      currentOmittedRelations = originalRelationsCount - currentRelations.length;
      this.logger.debug(`After reducing relations to ${targetRelations}: ${getCurrentSize()} chars`);
    }

    // If still too large, Step 3: Reduce entities (keep minimum 5)
    if (getCurrentSize() > maxChars && currentEntities.length > 5) {
      const targetEntities = Math.max(5, Math.floor(currentEntities.length * 0.7));
      const originalEntitiesCount = currentEntities.length + currentOmittedEntities;
      currentEntities = currentEntities.slice(0, targetEntities);
      currentOmittedEntities = originalEntitiesCount - currentEntities.length;
      this.logger.debug(`After reducing entities to ${targetEntities}: ${getCurrentSize()} chars`);
    }

    // Final size check - if still too large, more aggressive entity reduction
    while (getCurrentSize() > maxChars && currentEntities.length > 1) {
      const removedEntity = currentEntities.pop()!;
      currentOmittedEntities++;
      this.logger.debug(`Removed entity '${removedEntity.name}', current size: ${getCurrentSize()} chars`);
    }

    this.logger.debug(
      `Truncation completed: ${currentEntities.length} entities, ${currentRelations.length} relations, ` +
      `final size: ${getCurrentSize()} chars (limit: ${maxChars})`
    );

    return {
      finalEntities: currentEntities,
      finalRelations: currentRelations,
      wasTruncated,
      finalOmittedEntities: currentOmittedEntities,
      finalOmittedRelations: currentOmittedRelations,
    };
  }

  /**
   * Search using SQL LIKE queries for smaller datasets
   */
  private async searchWithLike(query: string, scope?: string, timeRange?: TimeRangeOptions): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();
      
      // Split query into search terms for more precise matching (similar to searchWithLikeFallback)
      const searchTerms = query.split(/\s+/).filter(term => term.length > 0);
      
      if (searchTerms.length === 0) {
        return [];
      }
      
      // Build dynamic WHERE clause for multiple search terms (AND logic for compatibility)
      const whereConditions = searchTerms.map(() => 
        "(e.name ILIKE ? OR e.entityType ILIKE ? OR o.content ILIKE ?)"
      ).join(" AND ");
      
      // Prepare parameters (each term used 3 times for name, entityType, content)
      const params = searchTerms.flatMap(term => {
        const likePattern = `%${term}%`;
        return [likePattern, likePattern, likePattern];
      });
      
      // Build scope filter if provided
      let scopeCondition = '';
      const scopeParams: any[] = [];
      
      if (scope) {
        // Support both "project:" and "[project]:" formats with case insensitive matching
        const cleanScope = scope.replace(/[\[\]]/g, '');
        scopeCondition = 'AND (e.name ILIKE ? OR e.name ILIKE ?)';
        scopeParams.push(`${cleanScope}:%`, `[${cleanScope}]:%`);
        this.logger.debug(`Scope filter applied: ${scope} -> ${scopeCondition} with params: [${scopeParams.join(', ')}]`);
      } else {
        this.logger.debug('No scope filter applied');
      }
      
      // Build time range filter if provided
      let timeCondition = '';
      const timeParams: any[] = [];
      
      if (timeRange) {
        const timeFilter = this.buildTimeCondition(timeRange);
        if (timeFilter.condition) {
          timeCondition = `AND (${timeFilter.condition})`;
          timeParams.push(...timeFilter.params);
          this.logger.debug(`Time filter applied: ${timeCondition}`);
        }
      }
      
      const queryParams = [...params, ...scopeParams, ...timeParams, `%${searchTerms[0]}%`, `%${searchTerms[0]}%`];
      
      const sql = `
        SELECT DISTINCT e.name, e.entityType, e.created_at
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
        WHERE (${whereConditions})
        ${scopeCondition}
        ${timeCondition}
        ORDER BY 
          -- Prioritize exact name matches
          CASE WHEN e.name ILIKE ? THEN 1
               WHEN e.entityType ILIKE ? THEN 2
               ELSE 3 END,
          e.created_at DESC
        LIMIT 500
      `;
      
      this.logger.debug('Executing SQL:', { sql, params: queryParams });
      
      const reader = await conn.runAndReadAll(sql, queryParams);
      
      const rows = reader.getRows();
      const entities: Entity[] = [];
      
      for (const row of rows) {
        const name = row[0] as string;
        const entityType = row[1] as string;
        const created_at = row[2];
        
        // Get observations for this entity
        const obsReader = await conn.runAndReadAll(
          "SELECT content FROM observations WHERE entityName = ? ORDER BY created_at",
          [name]
        );
        const obsRows = obsReader.getRows();
        const observations = obsRows.map(obsRow => obsRow[0] as string);
        
        entities.push({
          name,
          entityType,
          createdAt: convertTimestampToISOWithFallback(created_at),
          observations
        });
      }
      
      this.logger.debug(`LIKE search for "${query}" returned ${entities.length} entities`);
      return entities;
    } catch (error) {
      this.logger.error("Error in LIKE search", extractError(error));
      // Fall back to empty results rather than throwing
      return [];
    }
  }

  /**
   * Search using FTS approach with multiple keywords for large datasets
   */
  private async searchWithMultiKeywordFTS(keywords: string[], options?: MultiKeywordSearchOptions): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();
      
      if (keywords.length === 0) {
        return [];
      }
      
      const mode = options?.mode || 'OR';  // Default to OR mode
      const scope = options?.scope;
      const timeRange = options?.timeRange;
      
      // Build dynamic WHERE clause for multiple search terms
      // SECURITY NOTE: This dynamic SQL construction is safe because:
      // 1. whereConditions contains only fixed template strings with ? placeholders
      // 2. All user input is passed through prepared statement parameters
      // 3. No direct string concatenation of user data occurs
      const whereConditions = keywords.map(() => 
        "(name ILIKE ? OR entityType ILIKE ? OR observations_text ILIKE ?)"
      ).join(` ${mode} `);
      
      // Prepare parameters (each term used 3 times for name, entityType, observations)
      const params = keywords.flatMap(term => {
        const likePattern = `%${term}%`;
        return [likePattern, likePattern, likePattern];
      });
      
      // Add scope filter if provided
      let scopeCondition = '';
      const scopeParams: any[] = [];
      
      if (scope) {
        // Support both "project:" and "[project]:" formats with case insensitive matching
        const cleanScope = scope.replace(/[\[\]]/g, '');
        scopeCondition = ' AND (name ILIKE ? OR name ILIKE ?)';
        scopeParams.push(`${cleanScope}:%`, `[${cleanScope}]:%`);
        this.logger.debug(`Scope filter applied: ${scope} -> ${scopeCondition} with params: [${scopeParams.join(', ')}]`);
      }
      
      // Add time range filter if provided
      let timeCondition = '';
      const timeParams: any[] = [];
      
      if (timeRange) {
        const timeFilter = this.buildTimeCondition(timeRange);
        if (timeFilter.condition) {
          // For entity_search_view, use created_at directly (no table prefix needed)
          const viewTimeCondition = timeFilter.condition
            .replace(/e\.created_at/g, 'created_at')
            .replace(/o\.created_at/g, 'created_at');
          timeCondition = ` AND (${viewTimeCondition})`;
          timeParams.push(...timeFilter.params);
          this.logger.debug(`Time filter applied: ${viewTimeCondition} with params: [${timeFilter.params.join(', ')}]`);
        }
      }
      
      const reader = await conn.runAndReadAll(`
        SELECT DISTINCT name, entityType, created_at
        FROM entity_search_view
        WHERE (${whereConditions})${scopeCondition}${timeCondition}
        ORDER BY 
          -- Prioritize exact name matches
          CASE WHEN name ILIKE ? THEN 1
               WHEN entityType ILIKE ? THEN 2
               ELSE 3 END,
          created_at DESC
        LIMIT 500
      `, [...params, ...scopeParams, ...timeParams, `%${keywords[0]}%`, `%${keywords[0]}%`]);
      
      const rows = reader.getRows();
      const entities: Entity[] = [];
      
      for (const row of rows) {
        const name = row[0] as string;
        const entityType = row[1] as string;
        const created_at = row[2];
        
        // Get observations for this entity
        const obsReader = await conn.runAndReadAll(
          "SELECT content FROM observations WHERE entityName = ? ORDER BY created_at",
          [name]
        );
        const obsRows = obsReader.getRows();
        const observations = obsRows.map(obsRow => obsRow[0] as string);
        
        entities.push({
          name,
          entityType,
          createdAt: convertTimestampToISOWithFallback(created_at),
          observations
        });
      }
      
      this.logger.debug(`Multi-keyword FTS search for [${keywords.join(", ")}] returned ${entities.length} entities`);
      return entities;
    } catch (error) {
      this.logger.error("Error in multi-keyword FTS search", extractError(error));
      return [];
    }
  }

  /**
   * Search using SQL LIKE queries with multiple keywords for smaller datasets
   */
  private async searchWithMultiKeywordLike(keywords: string[], options?: MultiKeywordSearchOptions): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();
      
      if (keywords.length === 0) {
        return [];
      }
      
      const mode = options?.mode || 'OR';  // Default to OR mode
      const scope = options?.scope;
      const timeRange = options?.timeRange;
      
      // Build dynamic WHERE clause for multiple search terms
      // SECURITY NOTE: This dynamic SQL construction is safe because:
      // 1. whereConditions contains only fixed template strings with ? placeholders
      // 2. All user input is passed through prepared statement parameters
      // 3. No direct string concatenation of user data occurs
      const whereConditions = keywords.map(() => 
        "(e.name ILIKE ? OR e.entityType ILIKE ? OR o.content ILIKE ?)"
      ).join(` ${mode} `);
      
      // Prepare parameters (each term used 3 times for name, entityType, content)
      const params = keywords.flatMap(term => {
        const likePattern = `%${term}%`;
        return [likePattern, likePattern, likePattern];
      });
      
      // Add scope filter if provided
      let scopeCondition = '';
      const scopeParams: any[] = [];
      
      if (scope) {
        // Support both "project:" and "[project]:" formats with case insensitive matching
        const cleanScope = scope.replace(/[\[\]]/g, '');
        scopeCondition = ' AND (e.name ILIKE ? OR e.name ILIKE ?)';
        scopeParams.push(`${cleanScope}:%`, `[${cleanScope}]:%`);
        this.logger.debug(`Scope filter applied: ${scope} -> ${scopeCondition} with params: [${scopeParams.join(', ')}]`);
      }
      
      // Add time range filter if provided
      let timeCondition = '';
      const timeParams: any[] = [];
      
      if (timeRange) {
        const timeFilter = this.buildTimeCondition(timeRange);
        if (timeFilter.condition) {
          timeCondition = ` AND (${timeFilter.condition})`;
          timeParams.push(...timeFilter.params);
          this.logger.debug(`Time filter applied: ${timeFilter.condition} with params: [${timeFilter.params.join(', ')}]`);
        }
      }
      
      const reader = await conn.runAndReadAll(`
        SELECT DISTINCT e.name, e.entityType, e.created_at
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
        WHERE (${whereConditions})${scopeCondition}${timeCondition}
        ORDER BY 
          -- Prioritize exact name matches
          CASE WHEN e.name ILIKE ? THEN 1
               WHEN e.entityType ILIKE ? THEN 2
               ELSE 3 END,
          e.created_at DESC
        LIMIT 500
      `, [...params, ...scopeParams, ...timeParams, `%${keywords[0]}%`, `%${keywords[0]}%`]);
      
      const rows = reader.getRows();
      const entities: Entity[] = [];
      
      for (const row of rows) {
        const name = row[0] as string;
        const entityType = row[1] as string;
        const created_at = row[2];
        
        // Get observations for this entity
        const obsReader = await conn.runAndReadAll(
          "SELECT content FROM observations WHERE entityName = ? ORDER BY created_at",
          [name]
        );
        const obsRows = obsReader.getRows();
        const observations = obsRows.map(obsRow => obsRow[0] as string);
        
        entities.push({
          name,
          entityType,
          createdAt: convertTimestampToISOWithFallback(created_at),
          observations
        });
      }
      
      this.logger.debug(`Multi-keyword LIKE search for [${keywords.join(", ")}] returned ${entities.length} entities`);
      return entities;
    } catch (error) {
      this.logger.error("Error in multi-keyword LIKE search", extractError(error));
      return [];
    }
  }

  /**
   * Get entities by name
   */
  async openNodes(names: string[], options?: OpenNodesOptions): Promise<KnowledgeGraph> {
    if (names.length === 0) {
      return { entities: [], relations: [] };
    }

    // Default to include observations for backward compatibility
    const includeObservations = options?.includeObservations ?? true;

    try {
      const conn = await this.getConnection();
      const placeholders = names.map(() => "?").join(",");

      let query: string;
      let queryParams: string[];

      if (includeObservations) {
        // Original query with observations
        query = `
        SELECT e.name, e.entityType, e.created_at, o.content
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
        WHERE e.name IN (${placeholders})
        `;
        queryParams = names;
      } else {
        // Optimized query without observations
        query = `
        SELECT e.name, e.entityType, e.created_at, NULL as content
        FROM entities e
        WHERE e.name IN (${placeholders})
        `;
        queryParams = names;
      }

      const reader = await conn.runAndReadAll(query, queryParams);
      const rows = reader.getRows();

      const entitiesMap = new Map<string, Entity>();

      for (const row of rows) {
        const name = row[0] as string;
        const entityType = row[1] as string;
        const created_at = row[2];
        const content = row[3] as string | null;

        if (!entitiesMap.has(name)) {
          entitiesMap.set(name, {
            name,
            entityType,
            createdAt: convertTimestampToISOWithFallback(created_at),
            observations: includeObservations && content ? [content] : [],
          });
        } else if (includeObservations && content) {
          entitiesMap.get(name)!.observations.push(content);
        }
      }

      const entities = Array.from(entitiesMap.values());
      const entityNames = entities.map((entity) => entity.name);

      if (entityNames.length > 0) {
        const placeholders = entityNames.map(() => "?").join(",");
        const relationsReader = await conn.runAndReadAll(
          `
        SELECT from_entity as "from", to_entity as "to", relationType, created_at
        FROM relations
        WHERE from_entity IN (${placeholders})
        OR to_entity IN (${placeholders})
        `,
          [...entityNames, ...entityNames]
        );
        const relationsData = relationsReader.getRows();

        const relations = relationsData.map((row) => {
          const created_at = row[3];
          return {
            from: row[0] as string,
            to: row[1] as string,
            relationType: row[2] as string,
            createdAt: convertTimestampToISOWithFallback(created_at),
          };
        });

        return { entities, relations };
      } else {
        return { entities, relations: [] };
      }
    } catch (error: unknown) {
      this.logger.error("Error opening nodes", extractError(error));
      return { entities: [], relations: [] };
    }
  }

  /**
   * Read the entire knowledge graph
   * @returns The complete knowledge graph
   */
  async readGraph(): Promise<KnowledgeGraph> {
    try {
      // Get all entities
      const entities = await this.getAllEntities();

      const conn = await this.getConnection();

      // Get all relations
      const relationsReader = await conn.runAndReadAll(
        'SELECT from_entity as "from", to_entity as "to", relationType, created_at FROM relations'
      );
      const relationsData = relationsReader.getRows();

      // Convert results to an array of Relation objects
      const relations = relationsData.map((row) => {
        const created_at = row[3];
        return {
          from: row[0] as string,
          to: row[1] as string,
          relationType: row[2] as string,
          createdAt: convertTimestampToISOWithFallback(created_at)
        };
      });
      
      return {
        entities,
        relations,
      };
    } catch (error) {
      this.logger.error("Error in readGraph", extractError(error));
      throw error;
    }
  }

  /**
   * Schedule FTS index rebuild with debounce to avoid frequent rebuilds
   * Uses a 5-second debounce timer to batch multiple data changes
   */
  private async scheduleIndexRebuild(): Promise<void> {
    // Skip if FTS is not enabled
    if (!this.ftsEnabled) {
      this.logger.debug("FTS not enabled, skipping index rebuild scheduling");
      return;
    }

    // Skip if manager is closed
    if (this.closed) {
      this.logger.debug("Manager is closed, skipping index rebuild scheduling");
      return;
    }

    // Skip if migration is in progress to avoid conflicts with temporary tables
    if (this.concurrencyController.isOperationInProgress('migration')) {
      this.logger.debug("Migration in progress, skipping index rebuild scheduling");
      return;
    }

    // Skip if current entity count is below FTS threshold
    try {
      const entityCount = await this.getCachedEntityCount();
      if (entityCount < this.entityCountThreshold) {
        this.logger.debug(`Entity count (${entityCount}) below FTS threshold (${this.entityCountThreshold}), skipping index rebuild`);
        return;
      }
    } catch (error) {
      this.logger.warn("Failed to get entity count for FTS threshold check", extractError(error));
      return;
    }

    try {
      // Clear any existing timer to reset the debounce
      if (this.ftsRebuildTimer) {
        clearTimeout(this.ftsRebuildTimer);
        this.ftsRebuildTimer = null;
        this.logger.debug("Previous FTS rebuild timer cleared, resetting debounce");
      }

      // Schedule new rebuild with debounce
      this.ftsRebuildTimer = setTimeout(async () => {
        try {
          // Double-check migration status before rebuilding
          if (this.concurrencyController.isOperationInProgress('migration')) {
            this.logger.debug("Migration in progress, aborting scheduled FTS index rebuild");
            this.ftsRebuildTimer = null;
            // Reschedule for later
            await this.scheduleIndexRebuild();
            return;
          }
          
          this.logger.debug("Debounce timer expired, starting FTS index rebuild");
          await this.rebuildFTSIndexes();
          this.ftsRebuildTimer = null;
          this.logger.info("Scheduled FTS index rebuild completed successfully");
        } catch (error) {
          this.ftsRebuildTimer = null;
          // Log error but don't throw to prevent disrupting the main flow
          this.logger.error("Failed to rebuild FTS indexes in scheduled task", extractError(error));
        }
      }, DuckDBKnowledgeGraphManager.FTS_REBUILD_DEBOUNCE_MS);

      this.logger.debug(`FTS index rebuild scheduled with ${DuckDBKnowledgeGraphManager.FTS_REBUILD_DEBOUNCE_MS}ms debounce`);
    } catch (error) {
      // Handle any timer-related errors gracefully
      this.logger.error("Error scheduling FTS index rebuild", extractError(error));
    }
  }

  /**
   * Initialize EmbeddingQueueManager with proper configuration and callbacks
   */
  private async initializeEmbeddingQueueManager(): Promise<void> {
    if (!this.embeddingService) {
      this.logger.warn("Embedding service not available, EmbeddingQueueManager not initialized");
      return;
    }

    const config: EmbeddingQueueConfig = {
      debounceMs: parseInt(process.env.EMBEDDING_DEBOUNCE_MS || '3000'),
      batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || '10'),
      maxRetries: parseInt(process.env.EMBEDDING_MAX_RETRIES || '3'),
      autoGenerate: this.embeddingAutoGenerate
    };

    const callbacks: EmbeddingQueueCallbacks = {
      getConnection: async () => {
        if (!this.connection) {
          throw new Error('Database connection is not available');
        }
        return this.connection;
      },
      isVSSAvailable: () => this.isVSSAvailable(),
      isEntityEmbeddingsAvailable: () => this.checkEntityEmbeddingsTableExists()
    };

    this.embeddingQueueManager = new EmbeddingQueueManager(
      config,
      callbacks,
      this.logger,
      this.embeddingService
    );

    this.logger.info("EmbeddingQueueManager initialized successfully");
  }

  /**
   * Check if entity_embeddings table exists (Strategy C support)
   */
  private async checkEntityEmbeddingsTableExists(): Promise<boolean> {
    try {
      const result = await this.connection!.runAndReadAll(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = 'entity_embeddings'"
      );
      const rows = result.getRows();
      const count = Number(rows?.[0]?.[0] || 0);
      return count > 0;
    } catch (error) {
      this.logger.debug("Failed to check entity_embeddings table existence", extractError(error));
      return false;
    }
  }

  
  /**
   * Add entities to embedding queue for processing
   */
  private addEntitiesToEmbeddingQueue(entityNames: string[]): void {
    if (this.embeddingQueueManager) {
      this.embeddingQueueManager.addEntitiesToQueue(entityNames);
    }
  }

  /**
   * Add observations to embedding queue for processing
   */
  private addObservationsToEmbeddingQueue(observationIds: number[]): void {
    if (this.embeddingQueueManager) {
      this.embeddingQueueManager.addObservationsToQueue(observationIds);
    }
  }

  /**
   * Schedule embedding generation through the queue manager
   */
  private async scheduleEmbeddingGeneration(): Promise<void> {
    if (this.embeddingQueueManager) {
      await this.embeddingQueueManager.scheduleEmbeddingGeneration();
    }
  }

  /**
   * Get embedding queue status for diagnostics
   */
  public getEmbeddingQueueStatus(): any {
    if (this.embeddingQueueManager) {
      return this.embeddingQueueManager.getQueueStatus();
    }
    return {
      entityQueueSize: 0,
      observationQueueSize: 0,
      isScheduled: false,
      config: null
    };
  }

  /**
   * Get operation status for diagnostics
   */
  public getOperationStatus(): {
    states: Record<OperationType, boolean>;
    queueLength: number;
    processingQueue: boolean;
    queueStats?: any;
  } {
    const status = this.concurrencyController.getStatus();
    const queueStats = this.concurrencyController.getQueueStats();
    return {
      ...status,
      queueStats,
    };
  }

  /**
   * Initialize VSS services if environment supports it
   */
  private async initializeVSSServices(): Promise<void> {
    try {
      // Check if OpenAI API key is available
      const openaiApiKey = process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        this.logger.info("OpenAI API key not found, VSS services will not be available");
        return;
      }

      this.logger.info("Initializing VSS services...");

      // Initialize embedding service with complete configuration
      const embeddingConfig = {
        apiKey: openaiApiKey,
        model: "text-embedding-3-small",
        timeout: 30000,
        retries: 3,
        batchSize: 100,
        // baseURL can be added here if needed for custom endpoints
      };
      
      this.embeddingService = new OpenAIEmbeddingService(embeddingConfig);

      // Test embedding service health
      const isHealthy = await this.embeddingService.checkHealth();
      if (!isHealthy) {
        this.logger.warn("Embedding service health check failed, VSS services disabled");
        // Clean up service instance to ensure isVSSAvailable() returns false
        this.embeddingService = null;
        return;
      }

      // Initialize VSS manager with complete configuration
      const vssConfig = {
        enabled: true,
        indexParams: {
          metric: 'cosine' as const,
          efConstruction: 200,
          M: 16,
        },
        autoRebuild: {
          enabled: true,
          threshold: 0.1,
          batchSize: 100,
        },
        fallback: {
          enabled: true,
          fallbackToKeyword: true,
          healthCheckInterval: 60000,
        },
      };
      
      this.vssManager = new DuckDBVSSManager(
        this.connection!,
        this.embeddingService,
        vssConfig
      );

      await this.vssManager.initialize();

      // Initialize hybrid search engine
      const keywordSearchStrategy: SearchStrategy = {
        performKeywordSearch: async (query: string, options?: SearchNodesOptions): Promise<KeywordSearchResult[]> => {
          // Use existing FTS/LIKE search logic, adapted for SearchStrategy interface
          return this.performKeywordSearchInternal(query, options);
        }
      };

      this.hybridSearchEngine = new HybridSearchEngine(
        this.embeddingService,
        this.vssManager,
        keywordSearchStrategy
      );

      // Initialize EmbeddingQueueManager
      await this.initializeEmbeddingQueueManager();

      this.logger.info("VSS services initialized successfully");
    } catch (error) {
      this.logger.warn("Failed to initialize VSS services, semantic search will not be available", extractError(error));
      // Reset services on failure
      this.embeddingService = null;
      this.vssManager = null;
      this.hybridSearchEngine = null;
    }
  }

  /**
   * Perform traditional search (original FTS/LIKE logic)
   */
  private async performTraditionalSearch(
    query: string, 
    scope?: string, 
    timeRange?: TimeRangeOptions
  ): Promise<Entity[]> {
    const entityCount = await this.getCachedEntityCount();
    
    // Choose search strategy based on dataset size
    if (entityCount < this.entityCountThreshold) {
      // Small dataset: use SQL LIKE search
      this.logger.debug("Using LIKE search for small dataset");
      return await this.searchWithLike(query, scope, timeRange);
    } else {
      // Large dataset: use FTS search
      this.logger.debug("Using FTS search for large dataset");
      return await this.searchWithFTS(query, scope, timeRange);
    }
  }

  /**
   * Internal keyword search implementation for SearchStrategy interface
   */
  private async performKeywordSearchInternal(
    query: string, 
    options?: SearchNodesOptions
  ): Promise<KeywordSearchResult[]> {
    const entities = await this.performTraditionalSearch(query, options?.scope, options?.timeRange);

    // Convert to KeywordSearchResult format
    return entities.map(entity => ({
      entity,
      relevanceScore: 0.8, // Default relevance score for keyword matches
      matchSource: 'entity' as const, // Simplified - could be enhanced to detect actual match source
      matchedContent: undefined, // Could be enhanced to include matched content
    }));
  }

  /**
   * Check if VSS (semantic search) is available
   */
  public isVSSAvailable(): boolean {
    return !!(this.vssManager?.isEnabled() && this.embeddingService && this.hybridSearchEngine);
  }

  /**
   * Get VSS manager for direct access (if available)
   */
  public getVSSManager(): IVSSManager | null {
    return this.vssManager;
  }

  /**
   * Get embedding service for direct access (if available)
   */
  public getEmbeddingService(): IEmbeddingService | null {
    return this.embeddingService;
  }
}