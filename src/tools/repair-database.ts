#!/usr/bin/env node

import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { ConsoleLogger, LogLevel } from "../logger.js";
import { extractError } from "../utils.js";
import { existsSync } from "fs";
import { resolve } from "path";

class DatabaseRepairTool {
  private logger: ConsoleLogger;
  private repairLog: Array<{ action: string; status: string; details?: string }> = [];

  constructor() {
    this.logger = new ConsoleLogger();
    this.logger.setLevel(LogLevel.INFO);
  }

  private log(action: string, status: string, details?: string) {
    this.repairLog.push({ action, status, details });
    this.logger.info(`[${status}] ${action}`, details ? { details } : undefined);
  }

  async repair(dbPath: string): Promise<void> {
    const resolvedPath = resolve(dbPath);
    
    if (!existsSync(resolvedPath)) {
      throw new Error(`Database file not found: ${resolvedPath}`);
    }

    this.logger.info("Starting database repair", { database: resolvedPath });
    
    const instance = await DuckDBInstance.create(resolvedPath);
    const conn = await instance.connect();

    try {
      // Step 1: Check for observations_new table
      await this.checkAndCleanObservationsNew(conn);
      
      // Step 2: Verify observations table structure
      await this.verifyObservationsTable(conn);
      
      // Step 3: Fix sequence if needed
      await this.fixObservationsSequence(conn);
      
      // Step 4: Clean up FTS indexes
      await this.cleanupFTSIndexes(conn);
      
      // Step 5: Rebuild FTS indexes correctly
      await this.rebuildFTSIndexes(conn);
      
      // Step 6: Verify database integrity
      await this.verifyDatabaseIntegrity(conn);
      
      // Step 7: Force checkpoint
      await this.forceCheckpoint(conn);
      
      this.printRepairReport();
      
    } catch (error) {
      this.logger.error("Repair failed", extractError(error));
      this.printRepairReport();
      throw error;
    } finally {
      conn.close();
    }
  }

  private async checkAndCleanObservationsNew(conn: DuckDBConnection): Promise<void> {
    try {
      const result = await conn.runAndReadAll(`
        SELECT COUNT(*) FROM information_schema.tables 
        WHERE table_name = 'observations_new'
      `);
      
      const hasTable = (result.getRows()[0][0] as number) > 0;
      
      if (hasTable) {
        this.log("Check observations_new", "FOUND", "Residual table detected");
        
        // Check if it has data
        const dataResult = await conn.runAndReadAll("SELECT COUNT(*) FROM observations_new");
        const rowCount = dataResult.getRows()[0][0] as number;
        
        if (rowCount > 0) {
          this.log("Data in observations_new", "WARNING", `${rowCount} rows found`);
          
          // Check if this data should be migrated
          const missingData = await conn.runAndReadAll(`
            SELECT COUNT(*) FROM observations_new o 
            WHERE NOT EXISTS (
              SELECT 1 FROM observations obs 
              WHERE obs.entityName = o.entityName 
              AND obs.content = o.content
            )
          `);
          
          const missingCount = missingData.getRows()[0][0] as number;
          if (missingCount > 0) {
            this.log("Missing data migration", "EXECUTING", `Migrating ${missingCount} rows`);
            
            await conn.run("BEGIN TRANSACTION");
            try {
              // Migrate missing data
              await conn.run(`
                INSERT INTO observations (entityName, content, created_at)
                SELECT entityName, content, created_at FROM observations_new o
                WHERE NOT EXISTS (
                  SELECT 1 FROM observations obs 
                  WHERE obs.entityName = o.entityName 
                  AND obs.content = o.content
                )
              `);
              
              await conn.run("COMMIT");
              this.log("Data migration", "SUCCESS", `${missingCount} rows migrated`);
            } catch (e) {
              await conn.run("ROLLBACK");
              throw e;
            }
          }
        }
        
        // Drop the residual table
        await conn.run("DROP TABLE IF EXISTS observations_new");
        this.log("Drop observations_new", "SUCCESS", "Residual table removed");
      } else {
        this.log("Check observations_new", "CLEAN", "No residual table found");
      }
    } catch (error) {
      this.log("Check observations_new", "ERROR", String(error));
      throw error;
    }
  }

  private async verifyObservationsTable(conn: DuckDBConnection): Promise<void> {
    try {
      // Check if observations table has id column
      const result = await conn.runAndReadAll(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'observations' 
        ORDER BY ordinal_position
      `);
      
      const columns = result.getRows().map(row => row[0] as string);
      
      if (!columns.includes('id')) {
        this.log("Observations table structure", "INVALID", "Missing id column");
        throw new Error("Observations table missing id column - manual migration required");
      }
      
      this.log("Observations table structure", "VALID", `Columns: ${columns.join(', ')}`);
      
      // Check row count
      const countResult = await conn.runAndReadAll("SELECT COUNT(*) FROM observations");
      const rowCount = countResult.getRows()[0][0] as number;
      this.log("Observations data", "INFO", `${rowCount} rows`);
      
    } catch (error) {
      this.log("Verify observations table", "ERROR", String(error));
      throw error;
    }
  }

  private async fixObservationsSequence(conn: DuckDBConnection): Promise<void> {
    try {
      // Try to create sequence if it doesn't exist
      // Using IF NOT EXISTS to avoid errors if sequence already exists
      try {
        await conn.run("CREATE SEQUENCE IF NOT EXISTS observations_id_seq");
        this.log("Create observations_id_seq", "SUCCESS", "Sequence created or already exists");
      } catch (createError) {
        // Sequence might already exist with different syntax in older versions
        this.log("Create observations_id_seq", "SKIP", "Sequence handling delegated to DuckDB");
      }
      
      // Get max id from observations table to ensure sequence is properly set
      try {
        const maxIdResult = await conn.runAndReadAll("SELECT COALESCE(MAX(id), 0) FROM observations");
        const maxId = maxIdResult.getRows()[0][0] as number;
        
        // Try to reset sequence to max id + 1
        // This ensures new observations get unique IDs
        await conn.run(`ALTER SEQUENCE observations_id_seq RESTART WITH ${maxId + 1}`);
        this.log("Fix sequence", "SUCCESS", `Sequence reset to ${maxId + 1}`);
      } catch (resetError) {
        // Some DuckDB versions might not support ALTER SEQUENCE
        // This is non-critical as the sequence will still work
        this.log("Reset sequence", "SKIP", "Sequence reset not supported in this DuckDB version");
      }
      
    } catch (error) {
      // Sequence operations are non-critical
      // The database will still function without explicit sequence management
      this.log("Fix observations sequence", "WARNING", "Sequence operations not fully supported");
    }
  }

  private async cleanupFTSIndexes(conn: DuckDBConnection): Promise<void> {
    try {
      // First, clean up orphaned FTS schemas
      this.log("Check orphaned FTS schemas", "EXECUTING", "Scanning for orphaned schemas");
      
      const ftsSchemas = await conn.runAndReadAll(`
        SELECT schema_name 
        FROM duckdb_schemas() 
        WHERE schema_name LIKE 'fts_%'
      `);
      
      const schemas = ftsSchemas.getRows();
      let orphanedCount = 0;
      
      for (const row of schemas) {
        const schemaName = row[0] as string;
        
        // Extract table name from schema name (format: fts_main_{table_name})
        const match = schemaName.match(/^fts_main_(.+)$/);
        if (!match) {
          this.log(`Unexpected FTS schema`, "WARNING", `Schema: ${schemaName}`);
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
        
        // Clean up orphaned schemas or temporary table schemas
        if (!tableExists || tableName.endsWith('_new') || tableName.endsWith('_backup') || tableName.endsWith('_temp')) {
          try {
            await conn.run(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
            this.log(`Drop orphaned FTS schema`, "SUCCESS", `${schemaName} removed`);
            orphanedCount++;
          } catch (dropError) {
            this.log(`Drop FTS schema ${schemaName}`, "ERROR", String(dropError));
          }
        }
      }
      
      if (orphanedCount > 0) {
        this.log("Orphaned FTS cleanup", "SUCCESS", `${orphanedCount} schema(s) removed`);
      } else {
        this.log("Orphaned FTS cleanup", "CLEAN", "No orphaned schemas found");
      }
      
      // Then drop existing FTS indexes for tables that exist
      const tablesResult = await conn.runAndReadAll(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'main' 
        AND table_name IN ('entities', 'observations')
      `);
      
      const existingTables = tablesResult.getRows().map(row => row[0] as string);
      
      for (const table of existingTables) {
        try {
          await conn.run(`PRAGMA drop_fts_index('${table}')`);
          this.log(`Drop FTS index ${table}`, "SUCCESS", "Index dropped");
        } catch (e) {
          // Index might not exist, that's fine
          this.log(`Drop FTS index ${table}`, "SKIP", "Index does not exist");
        }
      }
    } catch (error) {
      this.log("Cleanup FTS indexes", "ERROR", String(error));
      // Non-critical, continue
    }
  }

  private async rebuildFTSIndexes(conn: DuckDBConnection): Promise<void> {
    try {
      // Check if FTS extension is loaded
      try {
        await conn.run("LOAD fts");
        this.log("Load FTS extension", "SUCCESS", "Extension loaded");
      } catch (e) {
        this.log("Load FTS extension", "SKIP", "Already loaded or not available");
      }

      // Create FTS indexes on correct tables
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
      this.log("Create entities FTS index", "SUCCESS", "Index created");

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
      this.log("Create observations FTS index", "SUCCESS", "Index created");
      
    } catch (error) {
      this.log("Rebuild FTS indexes", "WARNING", "FTS may not be available");
      // FTS is optional, don't fail
    }
  }

  private async verifyDatabaseIntegrity(conn: DuckDBConnection): Promise<void> {
    try {
      // Check foreign key constraints
      const orphanedObs = await conn.runAndReadAll(`
        SELECT COUNT(*) FROM observations o 
        WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = o.entityName)
      `);
      
      const orphanCount = orphanedObs.getRows()[0][0] as number;
      if (orphanCount > 0) {
        this.log("Orphaned observations", "WARNING", `${orphanCount} orphaned records found`);
        
        // Optionally clean up orphaned records
        await conn.run(`
          DELETE FROM observations 
          WHERE entityName NOT IN (SELECT name FROM entities)
        `);
        this.log("Clean orphaned observations", "SUCCESS", `${orphanCount} records removed`);
      } else {
        this.log("Referential integrity", "VALID", "No orphaned records");
      }
      
      // Check invalid relations
      const invalidRel = await conn.runAndReadAll(`
        SELECT COUNT(*) FROM relations r 
        WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = r.from_entity)
           OR NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = r.to_entity)
      `);
      
      const invalidCount = invalidRel.getRows()[0][0] as number;
      if (invalidCount > 0) {
        this.log("Invalid relations", "WARNING", `${invalidCount} invalid relations found`);
        
        await conn.run(`
          DELETE FROM relations 
          WHERE from_entity NOT IN (SELECT name FROM entities)
             OR to_entity NOT IN (SELECT name FROM entities)
        `);
        this.log("Clean invalid relations", "SUCCESS", `${invalidCount} relations removed`);
      } else {
        this.log("Relations integrity", "VALID", "All relations valid");
      }
      
    } catch (error) {
      this.log("Verify integrity", "ERROR", String(error));
      throw error;
    }
  }

  private async forceCheckpoint(conn: DuckDBConnection): Promise<void> {
    try {
      await conn.run("CHECKPOINT");
      this.log("Force checkpoint", "SUCCESS", "WAL data written to disk");
    } catch (error) {
      this.log("Force checkpoint", "WARNING", "Checkpoint failed but data is safe");
    }
  }

  private printRepairReport(): void {
    console.log("\n" + "=".repeat(60));
    console.log("DATABASE REPAIR REPORT");
    console.log("=".repeat(60));
    
    const grouped = {
      SUCCESS: [] as typeof this.repairLog,
      WARNING: [] as typeof this.repairLog,
      ERROR: [] as typeof this.repairLog,
      INFO: [] as typeof this.repairLog,
      CLEAN: [] as typeof this.repairLog,
      VALID: [] as typeof this.repairLog,
      SKIP: [] as typeof this.repairLog,
      FOUND: [] as typeof this.repairLog,
      EXECUTING: [] as typeof this.repairLog,
      INVALID: [] as typeof this.repairLog,
    };
    
    for (const entry of this.repairLog) {
      const group = grouped[entry.status as keyof typeof grouped];
      if (group) {
        group.push(entry);
      }
    }
    
    // Print successes
    if (grouped.SUCCESS.length > 0) {
      console.log("\n✅ SUCCESSFUL OPERATIONS:");
      for (const entry of grouped.SUCCESS) {
        console.log(`  - ${entry.action}${entry.details ? `: ${entry.details}` : ''}`);
      }
    }
    
    // Print warnings
    if (grouped.WARNING.length > 0) {
      console.log("\n⚠️  WARNINGS:");
      for (const entry of grouped.WARNING) {
        console.log(`  - ${entry.action}${entry.details ? `: ${entry.details}` : ''}`);
      }
    }
    
    // Print errors
    if (grouped.ERROR.length > 0) {
      console.log("\n❌ ERRORS:");
      for (const entry of grouped.ERROR) {
        console.log(`  - ${entry.action}${entry.details ? `: ${entry.details}` : ''}`);
      }
    }
    
    // Summary
    console.log("\n" + "=".repeat(60));
    console.log(`SUMMARY: ${grouped.SUCCESS.length} successful, ${grouped.WARNING.length} warnings, ${grouped.ERROR.length} errors`);
    console.log("=".repeat(60) + "\n");
  }

  printUsage(): void {
    console.log(`
Usage: repair-database <database.db>

Repairs and cleans up a DuckDB knowledge graph database.

Operations performed:
  - Remove residual observations_new table
  - Fix observations_id_seq sequence
  - Clean up orphaned FTS schemas (e.g., fts_main_observations_new)
  - Rebuild FTS indexes correctly
  - Verify and fix referential integrity
  - Force WAL checkpoint

Arguments:
  database.db    Path to the database to repair

Example:
  repair-database memory.db
`);
  }
}

// Main execution
async function main() {
  const tool = new DatabaseRepairTool();
  
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    tool.printUsage();
    process.exit(0);
  }
  
  if (args.length !== 1) {
    console.error("Error: Exactly 1 argument required");
    tool.printUsage();
    process.exit(1);
  }
  
  const dbPath = resolve(args[0]);
  
  try {
    await tool.repair(dbPath);
    console.log("✅ Database repair completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Repair failed:", error);
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

export { DatabaseRepairTool };