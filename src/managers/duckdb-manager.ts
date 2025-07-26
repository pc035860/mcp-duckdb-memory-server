import {
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  MultiKeywordSearchOptions,
  DatabaseRow,
} from "../types";
import { KnowledgeGraphManagerInterface } from "./interface";
import { Logger, ConsoleLogger } from "../logger";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import Fuse, { FuseResult } from "fuse.js";
import { dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { extractError, convertTimestampToISOWithFallback } from "../utils";

/**
 * DuckDB implementation with persistent connection (no cleanup per operation)
 */
export class DuckDBKnowledgeGraphManager implements KnowledgeGraphManagerInterface {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private fuse: Fuse<Entity>;
  private initialized: boolean = false;
  private dbPath: string;
  private logger: Logger;
  private closed: boolean = false;
  private allowExternalTimestamps: boolean = false;
  private entityCountThreshold: number;

  constructor(dbPathResolver: () => string, logger?: Logger, allowExternalTimestamps: boolean = false, entityCountThreshold: number = 1000) {
    const dbPath = dbPathResolver();
    this.dbPath = dbPath;
    this.logger = logger || new ConsoleLogger();
    this.allowExternalTimestamps = allowExternalTimestamps;
    this.entityCountThreshold = entityCountThreshold;

    // Create directory if it doesn't exist
    const dbPathDir = dirname(dbPath);
    if (!existsSync(dbPathDir)) {
      mkdirSync(dbPathDir, { recursive: true });
    }

    // Initialize Fuse.js
    this.fuse = new Fuse<Entity>([], {
      keys: ["name", "entityType", "observations"],
      includeScore: true,
      threshold: 0.4,
    });
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
      // Create DuckDB instance
      this.instance = await DuckDBInstance.create(this.dbPath);
      this.connection = await this.instance.connect();

      // Create tables if they don't exist
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS entities (
          name VARCHAR PRIMARY KEY,
          entityType VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS observations (
          entityName VARCHAR,
          content VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (entityName) REFERENCES entities(name),
          PRIMARY KEY (entityName, content)
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

      // Build Fuse.js index
      const entities = await this.getAllEntities();
      this.fuse.setCollection(entities);

      this.initialized = true;
      this.logger.info("DuckDB Manager initialized with persistent connection");
    } catch (error) {
      this.logger.error("Failed to initialize database", extractError(error));
      throw error;
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
   * Close the manager and cleanup resources
   */
  async close(): Promise<void> {
    if (this.closed) return;

    try {
      if (this.connection) {
        try {
          // Try to execute CHECKPOINT to ensure data is written to disk
          // But don't fail if it errors (e.g., WAL file issues)
          await this.connection.run("CHECKPOINT");
        } catch (checkpointError) {
          // Log but don't throw - this can happen if WAL file is already removed
          this.logger.debug("Checkpoint failed during close (non-fatal)", extractError(checkpointError));
        }
        
        this.connection.close();
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

      // Update Fuse.js index
      const allEntities = await this.getAllEntities();
      this.fuse.setCollection(allEntities);

      return createdEntities;
    } catch (error: unknown) {
      await conn.run("ROLLBACK");
      this.logger.error("Error creating entities", extractError(error));
      throw error;
    }
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

      // Update Fuse.js index
      const allEntities = await this.getAllEntities();
      this.fuse.setCollection(allEntities);

      return addedObservations;
    } catch (error: unknown) {
      await conn.run("ROLLBACK");
      this.logger.error("Error adding observations", extractError(error));
      throw error;
    }
  }

  /**
   * Delete entities
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    if (entityNames.length === 0) return;

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

      // Delete entities
      await conn.run(`DELETE FROM entities WHERE name IN (${placeholders})`, entityNames);

      // Update Fuse.js index
      const allEntities = await this.getAllEntities();
      this.fuse.setCollection(allEntities);
    } catch (error: unknown) {
      this.logger.error("Error deleting entities", extractError(error));
      throw error;
    }
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

      // Update Fuse.js index
      const allEntities = await this.getAllEntities();
      this.fuse.setCollection(allEntities);
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
   * - Fallback: Use Fuse.js fuzzy search if database search fails
   */
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    try {
      if (!query || query.trim() === "") {
        return { entities: [], relations: [] };
      }

      let entities: Entity[] = [];
      
      // Get entity count to determine search strategy
      const entityCount = await this.getEntityCount();
      this.logger.debug(`Entity count: ${entityCount}, choosing search strategy`);
      
      // Choose search strategy based on dataset size
      if (entityCount < this.entityCountThreshold) {
        // Small dataset: use SQL LIKE search
        this.logger.debug("Using LIKE search for small dataset");
        entities = await this.searchWithLike(query);
      } else {
        // Large dataset: use FTS search
        this.logger.debug("Using FTS search for large dataset");
        entities = await this.searchWithFTS(query);
      }
      
      // Fallback to Fuse.js if database search returns no results
      if (entities.length === 0) {
        this.logger.debug("Database search returned no results, falling back to Fuse.js");
        const allEntities = await this.getAllEntities();
        this.fuse.setCollection(allEntities);
        const results = this.fuse.search(query);
        
        const uniqueEntities = new Map<string, Entity>();
        for (const result of results) {
          if (!uniqueEntities.has(result.item.name)) {
            uniqueEntities.set(result.item.name, result.item);
          }
        }
        entities = Array.from(uniqueEntities.values());
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

      this.logger.debug(`Search completed: ${entities.length} entities, ${relations.length} relations`);
      return { entities, relations };
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
      const query = validKeywords.join(" ");
      const entityCount = await this.getEntityCount();
      
      let entities: Entity[] = [];
      
      if (entityCount < this.entityCountThreshold) {
        // Small dataset: use SQL LIKE search with multiple keywords
        this.logger.debug("Using LIKE search for multi-keyword search");
        entities = await this.searchWithMultiKeywordLike(validKeywords);
      } else {
        // Large dataset: use FTS search with multiple keywords
        this.logger.debug("Using FTS search for multi-keyword search");
        entities = await this.searchWithMultiKeywordFTS(validKeywords);
      }
      
      // Fallback to Fuse.js if database search returns no results
      if (entities.length === 0) {
        this.logger.debug("Database search returned no results, falling back to Fuse.js");
        const allEntities = await this.getAllEntities();
        this.fuse.setCollection(allEntities);
        return await this._performMultiKeywordSearch(validKeywords, options);
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

      this.logger.debug(`Multi-keyword search completed: ${entities.length} entities, ${relations.length} relations`);
      return { entities, relations };
    } catch (error) {
      this.logger.error("Error in searchMultiKeywords", extractError(error));
      throw error;
    }
  }

  /**
   * Internal method to perform multi-keyword search
   */
  private async _performMultiKeywordSearch(
    keywords: string[],
    options?: MultiKeywordSearchOptions
  ): Promise<KnowledgeGraph> {
    const mode = options?.mode || "OR";
    const fields = options?.fields || ["name", "entityType", "observations"];

    // Prepare search options with optional threshold
    const searchOptions: any = {};
    if (options?.threshold !== undefined) {
      searchOptions.threshold = options.threshold;
    }

    let results: FuseResult<Entity>[];

    if (mode === "OR") {
      const orQuery = {
        $or: keywords.map((keyword) => ({
          $or: fields.map((field) => ({ [field]: keyword })),
        })),
      };
      results = this.fuse.search(orQuery, searchOptions);
    } else {
      const allResults = new Map<string, { item: Entity; score: number }>();

      for (let i = 0; i < keywords.length; i++) {
        const keyword = keywords[i];
        const keywordQuery = {
          $or: fields.map((field) => ({ [field]: keyword })),
        };
        const keywordResults = this.fuse.search(keywordQuery, searchOptions);

        if (i === 0) {
          for (const result of keywordResults) {
            allResults.set(result.item.name, {
              item: result.item,
              score: result.score!,
            });
          }
        } else {
          const currentMatches = new Set(keywordResults.map((r) => r.item.name));
          for (const [name, result] of allResults) {
            if (!currentMatches.has(name)) {
              allResults.delete(name);
            }
          }
        }
      }

      results = Array.from(allResults.values()).map((r) => ({
        item: r.item,
        score: r.score,
        refIndex: 0,
      }));
    }

    const uniqueEntities = new Map<string, Entity>();
    for (const result of results) {
      if (!uniqueEntities.has(result.item.name)) {
        uniqueEntities.set(result.item.name, result.item);
      }
    }

    const entities = Array.from(uniqueEntities.values());
    const entityNames = entities.map((entity) => entity.name);

    if (entityNames.length === 0) {
      return { entities: [], relations: [] };
    }

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

    return { entities, relations };
  }

  /**
   * Initialize Full-Text Search capabilities
   * Creates entity_search_view for FTS operations
   */
  private async initializeFTS(): Promise<void> {
    try {
      const conn = await this.getConnection();
      
      // Create a view that combines entities and observations for FTS
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
      
      this.logger.debug("FTS view 'entity_search_view' created successfully");
    } catch (error) {
      // FTS initialization failure is non-fatal, log and continue
      this.logger.warn("Failed to initialize FTS capabilities, falling back to LIKE search", extractError(error));
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
  private async searchWithFTS(query: string): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();
      
      // Use LIKE search on the view for full-text search
      // DuckDB doesn't have built-in FTS like SQLite, so we use optimized LIKE queries
      const searchTerms = query.trim().split(/\s+/).filter(term => term.length > 0);
      
      if (searchTerms.length === 0) {
        return [];
      }
      
      // Build dynamic WHERE clause for multiple search terms
      // SECURITY NOTE: This dynamic SQL construction is safe because:
      // 1. whereConditions contains only fixed template strings with ? placeholders
      // 2. All user input is passed through prepared statement parameters
      // 3. No direct string concatenation of user data occurs
      const whereConditions = searchTerms.map(() => 
        "(name ILIKE ? OR entityType ILIKE ? OR observations_text ILIKE ?)"
      ).join(" AND ");
      
      // Prepare parameters (each term used 3 times for name, entityType, observations)
      const params = searchTerms.flatMap(term => {
        const likePattern = `%${term}%`;
        return [likePattern, likePattern, likePattern];
      });
      
      const reader = await conn.runAndReadAll(`
        SELECT DISTINCT name, entityType, created_at
        FROM entity_search_view
        WHERE ${whereConditions}
        ORDER BY 
          -- Prioritize exact name matches
          CASE WHEN name ILIKE ? THEN 1
               WHEN entityType ILIKE ? THEN 2
               ELSE 3 END,
          created_at DESC
        LIMIT 500
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
      
      this.logger.debug(`FTS search for "${query}" returned ${entities.length} entities`);
      return entities;
    } catch (error) {
      this.logger.error("Error in FTS search", extractError(error));
      // Fall back to empty results rather than throwing
      return [];
    }
  }

  /**
   * Search using SQL LIKE queries for smaller datasets
   */
  private async searchWithLike(query: string): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();
      const likePattern = `%${query}%`;
      
      const reader = await conn.runAndReadAll(`
        SELECT DISTINCT e.name, e.entityType, e.created_at
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
        WHERE e.name ILIKE ?
           OR e.entityType ILIKE ?
           OR o.content ILIKE ?
        ORDER BY 
          -- Prioritize exact name matches
          CASE WHEN e.name ILIKE ? THEN 1
               WHEN e.entityType ILIKE ? THEN 2
               ELSE 3 END,
          e.created_at DESC
        LIMIT 500
      `, [likePattern, likePattern, likePattern, `%${query}%`, `%${query}%`]);
      
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
  private async searchWithMultiKeywordFTS(keywords: string[]): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();
      
      if (keywords.length === 0) {
        return [];
      }
      
      // Build dynamic WHERE clause for multiple search terms (AND logic)
      // SECURITY NOTE: This dynamic SQL construction is safe because:
      // 1. whereConditions contains only fixed template strings with ? placeholders
      // 2. All user input is passed through prepared statement parameters
      // 3. No direct string concatenation of user data occurs
      const whereConditions = keywords.map(() => 
        "(name ILIKE ? OR entityType ILIKE ? OR observations_text ILIKE ?)"
      ).join(" AND ");
      
      // Prepare parameters (each term used 3 times for name, entityType, observations)
      const params = keywords.flatMap(term => {
        const likePattern = `%${term}%`;
        return [likePattern, likePattern, likePattern];
      });
      
      const reader = await conn.runAndReadAll(`
        SELECT DISTINCT name, entityType, created_at
        FROM entity_search_view
        WHERE ${whereConditions}
        ORDER BY 
          -- Prioritize exact name matches
          CASE WHEN name ILIKE ? THEN 1
               WHEN entityType ILIKE ? THEN 2
               ELSE 3 END,
          created_at DESC
        LIMIT 500
      `, [...params, `%${keywords[0]}%`, `%${keywords[0]}%`]);
      
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
  private async searchWithMultiKeywordLike(keywords: string[]): Promise<Entity[]> {
    try {
      const conn = await this.getConnection();
      
      if (keywords.length === 0) {
        return [];
      }
      
      // Build dynamic WHERE clause for multiple search terms (AND logic)
      // SECURITY NOTE: This dynamic SQL construction is safe because:
      // 1. whereConditions contains only fixed template strings with ? placeholders
      // 2. All user input is passed through prepared statement parameters
      // 3. No direct string concatenation of user data occurs
      const whereConditions = keywords.map(() => 
        "(e.name ILIKE ? OR e.entityType ILIKE ? OR o.content ILIKE ?)"
      ).join(" AND ");
      
      // Prepare parameters (each term used 3 times for name, entityType, content)
      const params = keywords.flatMap(term => {
        const likePattern = `%${term}%`;
        return [likePattern, likePattern, likePattern];
      });
      
      const reader = await conn.runAndReadAll(`
        SELECT DISTINCT e.name, e.entityType, e.created_at
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
        WHERE ${whereConditions}
        ORDER BY 
          -- Prioritize exact name matches
          CASE WHEN e.name ILIKE ? THEN 1
               WHEN e.entityType ILIKE ? THEN 2
               ELSE 3 END,
          e.created_at DESC
        LIMIT 500
      `, [...params, `%${keywords[0]}%`, `%${keywords[0]}%`]);
      
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
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    if (names.length === 0) {
      return { entities: [], relations: [] };
    }

    try {
      const conn = await this.getConnection();
      const placeholders = names.map(() => "?").join(",");

      const reader = await conn.runAndReadAll(
        `
        SELECT e.name, e.entityType, e.created_at, o.content
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entityName
        WHERE e.name IN (${placeholders})
      `,
        names
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
}