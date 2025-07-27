#!/usr/bin/env node

import { DuckDBKnowledgeGraphManager } from "../managers/duckdb-manager.js";
import { ConsoleLogger, LogLevel } from "../logger.js";
import { existsSync, statSync } from "fs";
import { basename, resolve, isAbsolute, normalize } from "path";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";

class DuckDBMergeTool {
  private logger: ConsoleLogger;
  private readonly MAX_FILE_SIZE_MB = 5000; // 5GB max file size to prevent DoS

  constructor() {
    this.logger = new ConsoleLogger();
    this.logger.setLevel(LogLevel.INFO);
  }

  /**
   * Escape single quotes in SQL strings to prevent SQL injection
   */
  private escapeSQLString(str: string): string {
    // DuckDB uses single quotes for strings, so we need to escape them by doubling
    return str.replace(/'/g, "''");
  }

  /**
   * Validate that a file path is safe (security checks)
   */
  private validatePathSecurity(filePath: string): string {
    // Resolve to absolute path and normalize to prevent directory traversal
    const resolvedPath = resolve(filePath);
    const normalizedPath = normalize(resolvedPath);
    
    // Ensure the normalized path equals resolved path (no directory traversal)
    if (resolvedPath !== normalizedPath) {
      throw new Error(`Invalid file path: potential directory traversal detected`);
    }

    // Check for control characters and null bytes in the entire path
    if (normalizedPath.includes('\0')) {
      throw new Error(`Invalid file path: contains null byte`);
    }
    if (normalizedPath.includes('\n')) {
      throw new Error(`Invalid file path: contains newline character`);
    }
    if (normalizedPath.includes('\r')) {
      throw new Error(`Invalid file path: contains carriage return`);
    }
    
    // These patterns should be checked in the filename only, not the full path
    const filename = basename(normalizedPath);
    const dangerousFilenamePatterns = ['|', '&', '>', '<', '`', ';'];
    for (const pattern of dangerousFilenamePatterns) {
      if (filename.includes(pattern)) {
        throw new Error(`Invalid file path: contains suspicious pattern '${pattern}'`);
      }
    }

    return normalizedPath;
  }

  /**
   * Validate that a database file exists and is accessible
   */
  private validateDatabaseFile(filePath: string): void {
    // Check if file exists
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    // Check file size to prevent DoS attacks
    const fileSizeMB = stats.size / (1024 * 1024);
    if (fileSizeMB > this.MAX_FILE_SIZE_MB) {
      throw new Error(`File too large: ${fileSizeMB.toFixed(2)}MB exceeds maximum allowed size of ${this.MAX_FILE_SIZE_MB}MB`);
    }
  }

  /**
   * Merge two DuckDB databases into a new output database
   */
  async merge(source1Path: string, source2Path: string, outputPath: string): Promise<void> {
    const startTime = Date.now();
    
    this.logger.info("Starting DuckDB database merge", {
      source1: source1Path,
      source2: source2Path,
      output: outputPath
    });

    // First validate path security for all paths
    this.logger.info("Validating paths...");
    const validatedSource1Path = this.validatePathSecurity(source1Path);
    const validatedSource2Path = this.validatePathSecurity(source2Path);
    const validatedOutputPath = this.validatePathSecurity(outputPath);
    
    // Then check if source files exist and are valid
    this.logger.info("Validating source databases...");
    this.validateDatabaseFile(validatedSource1Path);
    this.validateDatabaseFile(validatedSource2Path);

    // Check if output already exists
    if (existsSync(validatedOutputPath)) {
      throw new Error(`Output file already exists: ${validatedOutputPath}. Please remove it or choose a different path.`);
    }

    // Create output database with the manager
    this.logger.info("Creating output database...");
    const outputManager = new DuckDBKnowledgeGraphManager(() => validatedOutputPath, this.logger, true);
    await outputManager.initialize();
    
    // Close the manager to release the connection before we attach databases
    await outputManager.close();

    // Get a fresh connection to perform merge operations
    const outputInstance = await DuckDBInstance.create(validatedOutputPath);
    const outputConn = await outputInstance.connect();

    try {
      // Attach source databases with properly escaped paths
      this.logger.info("Attaching source databases...");
      const escapedSource1Path = this.escapeSQLString(validatedSource1Path);
      const escapedSource2Path = this.escapeSQLString(validatedSource2Path);
      
      await outputConn.run(`ATTACH '${escapedSource1Path}' AS source1 (READ_ONLY)`);
      await outputConn.run(`ATTACH '${escapedSource2Path}' AS source2 (READ_ONLY)`);
      
      // Validate schema after attachment
      try {
        // Check if required tables exist in source1
        await outputConn.run("SELECT 1 FROM source1.entities LIMIT 1");
        await outputConn.run("SELECT 1 FROM source1.observations LIMIT 1");
        await outputConn.run("SELECT 1 FROM source1.relations LIMIT 1");
        
        // Check if required tables exist in source2
        await outputConn.run("SELECT 1 FROM source2.entities LIMIT 1");
        await outputConn.run("SELECT 1 FROM source2.observations LIMIT 1");
        await outputConn.run("SELECT 1 FROM source2.relations LIMIT 1");
      } catch (error) {
        throw new Error(`Invalid schema in source databases. One or more required tables (entities, observations, relations) are missing. ${error}`);
      }

      // Start transaction for atomic merge
      await outputConn.run("BEGIN TRANSACTION");
      
      try {

      // Merge entities - keep earliest created_at but latest entityType
      this.logger.info("Merging entities...");
      
      // Strategy: For duplicate entity names, keep earliest created_at but latest entityType
      // This allows entity types to evolve over time while preserving original creation time
      await outputConn.run(`
        INSERT INTO entities (name, entityType, created_at)
        WITH combined_entities AS (
          SELECT name, entityType, created_at
          FROM source1.entities
          UNION ALL
          SELECT name, entityType, created_at
          FROM source2.entities
        ),
        entity_with_ranks AS (
          SELECT 
            name,
            entityType,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC) as earliest_rank,
            ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at DESC) as latest_rank
          FROM combined_entities
        )
        SELECT 
          e1.name,
          e2.entityType,  -- Latest entityType
          e1.created_at   -- Earliest created_at
        FROM entity_with_ranks e1
        JOIN entity_with_ranks e2 ON e1.name = e2.name
        WHERE e1.earliest_rank = 1 AND e2.latest_rank = 1
      `);
      
      const entitiesCountResult = await outputConn.runAndReadAll("SELECT COUNT(*) FROM entities");
      const entitiesCount = entitiesCountResult.getRows()[0][0] as number;
      this.logger.info(`Total entities: ${entitiesCount}`);

      // Merge observations - union all unique observations per entity
      this.logger.info("Merging observations...");
      
      // First deduplicate within each source, then combine and deduplicate again
      // Use MIN(created_at) to keep the earliest timestamp for each unique observation
      await outputConn.run(`
        INSERT INTO observations (entityName, content, created_at)
        SELECT entityName, content, MIN(created_at) as created_at
        FROM (
          (
            SELECT entityName, content, MIN(created_at) as created_at
            FROM source1.observations
            GROUP BY entityName, content
          )
          UNION ALL
          (
            SELECT entityName, content, MIN(created_at) as created_at
            FROM source2.observations
            GROUP BY entityName, content
          )
        ) combined
        GROUP BY entityName, content
      `);

      // Get total observation count
      const totalObsResult = await outputConn.runAndReadAll("SELECT COUNT(*) FROM observations");
      const totalObs = totalObsResult.getRows()[0][0] as number;
      this.logger.info(`Total observations: ${totalObs}`);

      // Merge relations - keep earliest created_at when triple matches
      this.logger.info("Merging relations...");
      
      // First deduplicate within each source, then combine and deduplicate again
      // Use MIN(created_at) to keep the earliest timestamp for each unique relation triple
      await outputConn.run(`
        INSERT INTO relations (from_entity, to_entity, relationType, created_at)
        SELECT from_entity, to_entity, relationType, MIN(created_at) as created_at
        FROM (
          (
            SELECT from_entity, to_entity, relationType, MIN(created_at) as created_at
            FROM source1.relations
            GROUP BY from_entity, to_entity, relationType
          )
          UNION ALL
          (
            SELECT from_entity, to_entity, relationType, MIN(created_at) as created_at
            FROM source2.relations
            GROUP BY from_entity, to_entity, relationType
          )
        ) combined
        GROUP BY from_entity, to_entity, relationType
      `);
      
      const relationsCountResult = await outputConn.runAndReadAll("SELECT COUNT(*) FROM relations");
      const relationsCount = relationsCountResult.getRows()[0][0] as number;
      this.logger.info(`Total relations: ${relationsCount}`);

      // Verify referential integrity
      this.logger.info("Verifying referential integrity...");
      
      // Check for orphaned observations
      const orphanedObsResult = await outputConn.runAndReadAll(`
        SELECT COUNT(*) FROM observations o 
        WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = o.entityName)
      `);
      const orphanedObs = orphanedObsResult.getRows()[0][0] as number;
      if (orphanedObs > 0) {
        throw new Error(`Found ${orphanedObs} orphaned observations`);
      }

      // Check for invalid relations
      const invalidRelResult = await outputConn.runAndReadAll(`
        SELECT COUNT(*) FROM relations r 
        WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = r.from_entity)
           OR NOT EXISTS (SELECT 1 FROM entities e WHERE e.name = r.to_entity)
      `);
      const invalidRel = invalidRelResult.getRows()[0][0] as number;
      if (invalidRel > 0) {
        throw new Error(`Found ${invalidRel} invalid relations`);
      }

        // Commit transaction
        await outputConn.run("COMMIT");
        this.logger.info("Merge completed successfully!");
        
        // Force WAL data to be written to main database file
        this.logger.info("Forcing WAL checkpoint to ensure data persistence...");
        try {
          await outputConn.run("CHECKPOINT");
          this.logger.info("WAL checkpoint completed successfully");
        } catch (checkpointError) {
          // CHECKPOINT failures should be logged as warnings but not fail the merge
          // since data is already committed to the transaction log
          this.logger.warn("CHECKPOINT operation failed, but data is still safely committed", { 
            error: checkpointError 
          });
        }
        
        // Final statistics
        const statsResult = await outputConn.runAndReadAll(`
          SELECT 
            (SELECT COUNT(*) FROM entities) as entity_count,
            (SELECT COUNT(*) FROM observations) as observation_count,
            (SELECT COUNT(*) FROM relations) as relation_count
        `);
        const stats = statsResult.getRows()[0];
        const duration = Date.now() - startTime;

        this.logger.info("Merge statistics", {
          entities: stats[0],
          observations: stats[1],
          relations: stats[2],
          duration_ms: duration,
          duration_s: (duration / 1000).toFixed(2)
        });
      } catch (innerError) {
        // Rollback on any error during the merge
        try {
          // Check if we're in a transaction before rolling back
          const result = await outputConn.runAndReadAll("SELECT 1 WHERE txid_current() IS NOT NULL");
          if (result.getRows().length > 0) {
            await outputConn.run("ROLLBACK");
          }
        } catch (rollbackError) {
          this.logger.debug("Failed to rollback transaction (may not be in transaction)", { error: rollbackError });
        }
        throw innerError;
      }
      
    } catch (error) {
      // Rollback on error if in transaction
      try {
        // Check if we're in a transaction before rolling back
        const result = await outputConn.runAndReadAll("SELECT 1 WHERE txid_current() IS NOT NULL");
        if (result.getRows().length > 0) {
          await outputConn.run("ROLLBACK");
        }
      } catch (rollbackError) {
        this.logger.debug("Failed to rollback transaction (may not be in transaction)", { error: rollbackError });
      }
      throw error;
    } finally {
      // Cleanup
      try {
        await outputConn.run("DETACH source1");
        await outputConn.run("DETACH source2");
      } catch (detachError) {
        this.logger.debug("Failed to detach databases", { error: detachError });
      }
      
      outputConn?.close();
    }
  }

  /**
   * Print usage information
   */
  printUsage(): void {
    console.log(`
Usage: merge-duckdb <source1.db> <source2.db> <output.db>

Merges two DuckDB knowledge graph databases into a new output database.

Arguments:
  source1.db    Path to the first source database
  source2.db    Path to the second source database  
  output.db     Path where the merged database will be created

Merge Rules:
  - Entities: Keeps the one with earlier created_at when names match
  - Observations: Unions all unique observations per entity
  - Relations: Keeps the one with earlier created_at when (from, to, type) matches

Example:
  merge-duckdb memory1.db memory2.db merged.db
`);
  }
}

// Main execution
async function main() {
  const tool = new DuckDBMergeTool();
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    tool.printUsage();
    process.exit(0);
  }
  
  if (args.length !== 3) {
    console.error("Error: Exactly 3 arguments required");
    tool.printUsage();
    process.exit(1);
  }
  
  const [source1, source2, output] = args.map(p => resolve(p));
  
  try {
    await tool.merge(source1, source2, output);
    process.exit(0);
  } catch (error) {
    console.error("Merge failed:", error);
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

export { DuckDBMergeTool };