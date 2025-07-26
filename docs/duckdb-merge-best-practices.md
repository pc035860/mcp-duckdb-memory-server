# DuckDB Database Merge Best Practices

## Overview

This document outlines best practices for merging two DuckDB databases with the same schema, focusing on efficient data copying, conflict resolution strategies, preserving timestamps, transaction management, and performance optimization.

## Table of Contents

1. [Database Attachment and Basic Copying](#database-attachment-and-basic-copying)
2. [Conflict Resolution Strategies](#conflict-resolution-strategies)
3. [Transaction Management](#transaction-management)
4. [Performance Optimization](#performance-optimization)
5. [Complete Merge Implementation](#complete-merge-implementation)
6. [Knowledge Graph Specific Implementation](#knowledge-graph-specific-implementation)

## Database Attachment and Basic Copying

### Attaching Multiple Databases

DuckDB allows you to work with multiple databases simultaneously using the `ATTACH` statement:

```sql
-- Attach source and destination databases
ATTACH 'source.db' AS source_db;
ATTACH 'destination.db' AS dest_db;

-- List all attached databases
SHOW DATABASES;

-- Query across databases
SELECT * FROM source_db.entities;
```

### Basic Database Copy

The simplest approach to copy an entire database:

```sql
-- Copy entire database (schema + data)
COPY FROM DATABASE source_db TO dest_db;

-- Copy only schema (without data)
COPY FROM DATABASE source_db TO dest_db (SCHEMA);
```

## Conflict Resolution Strategies

### Strategy 1: INSERT OR REPLACE (Full Row Replacement)

Replaces the entire row when a primary key conflict occurs:

```sql
-- Simple replacement of conflicting rows
INSERT OR REPLACE INTO dest_db.entities 
SELECT * FROM source_db.entities;

-- Equivalent to:
INSERT INTO dest_db.entities 
SELECT * FROM source_db.entities
ON CONFLICT DO UPDATE SET 
    entityType = EXCLUDED.entityType,
    created_at = EXCLUDED.created_at;
```

### Strategy 2: ON CONFLICT DO UPDATE (Selective Updates)

Provides fine-grained control over which columns to update:

```sql
-- Keep earliest created_at for entities
INSERT INTO dest_db.entities (name, entityType, created_at)
SELECT name, entityType, created_at FROM source_db.entities
ON CONFLICT (name) DO UPDATE SET
    entityType = EXCLUDED.entityType,
    created_at = CASE 
        WHEN entities.created_at < EXCLUDED.created_at 
        THEN entities.created_at 
        ELSE EXCLUDED.created_at 
    END;
```

### Strategy 3: ON CONFLICT DO NOTHING (Skip Duplicates)

Ignores rows that would cause conflicts:

```sql
-- Skip conflicting rows entirely
INSERT INTO dest_db.entities 
SELECT * FROM source_db.entities
ON CONFLICT DO NOTHING;
```

### Handling Composite Primary Keys

For tables with composite primary keys:

```sql
-- For observations table with (entityName, content) as primary key
INSERT INTO dest_db.observations 
SELECT * FROM source_db.observations
ON CONFLICT (entityName, content) DO UPDATE SET
    created_at = CASE 
        WHEN observations.created_at < EXCLUDED.created_at 
        THEN observations.created_at 
        ELSE EXCLUDED.created_at 
    END;
```

## Transaction Management

### Basic Transaction Pattern

Ensure atomicity of merge operations:

```sql
BEGIN TRANSACTION;

-- Perform merge operations
INSERT INTO dest_db.entities ...;
INSERT INTO dest_db.observations ...;
INSERT INTO dest_db.relations ...;

-- Verify data integrity
SELECT assert(
    (SELECT COUNT(*) FROM dest_db.entities) > 0,
    'Entities table should not be empty'
);

COMMIT;
```

### Error Handling with Rollback

```sql
BEGIN TRANSACTION;

-- Attempt merge operations
-- ...

-- If something goes wrong
ROLLBACK;
```

### Creating Assertions for Data Validation

```sql
-- Create a macro for assertions
CREATE MACRO assert(condition, message) AS
    CASE WHEN NOT condition THEN error(message) END;

-- Use in transactions
BEGIN TRANSACTION;
-- Merge operations...
SELECT assert(
    (SELECT COUNT(*) FROM dest_db.entities WHERE created_at IS NULL) = 0,
    'All entities must have created_at timestamp'
);
COMMIT;
```

## Performance Optimization

### 1. Use Bulk Operations

Avoid row-by-row operations for large datasets:

```sql
-- BAD: Row-by-row insertion (very slow)
-- DO NOT loop through individual INSERT statements

-- GOOD: Bulk insert with single statement
INSERT INTO dest_db.entities 
SELECT * FROM source_db.entities
WHERE name NOT IN (SELECT name FROM dest_db.entities);
```

### 2. Batch Large Operations

For very large datasets, process in batches:

```sql
-- Process in chunks of 100,000 rows
INSERT INTO dest_db.entities 
SELECT * FROM source_db.entities
WHERE name NOT IN (SELECT name FROM dest_db.entities)
LIMIT 100000;
```

### 3. Use COPY for Large Data Transfers

The COPY statement is optimized for bulk operations:

```sql
-- Export to temporary file
COPY source_db.entities TO '/tmp/entities.parquet' (FORMAT PARQUET);

-- Import with conflict handling
INSERT OR REPLACE INTO dest_db.entities 
SELECT * FROM '/tmp/entities.parquet';
```

### 4. Optimize Transaction Size

Balance between atomicity and performance:

```sql
-- For very large merges, consider multiple transactions
-- Process each table in its own transaction

-- Transaction 1: Entities
BEGIN TRANSACTION;
INSERT OR REPLACE INTO dest_db.entities 
SELECT * FROM source_db.entities;
COMMIT;

-- Transaction 2: Observations
BEGIN TRANSACTION;
INSERT OR REPLACE INTO dest_db.observations 
SELECT * FROM source_db.observations;
COMMIT;
```

## Complete Merge Implementation

### Full Merge Strategy for Knowledge Graph

Here's a complete implementation for merging knowledge graph databases:

```sql
-- 1. Attach both databases
ATTACH 'source.db' AS source_db;
ATTACH 'destination.db' AS dest_db;

-- 2. Create assertion macro
CREATE MACRO assert(condition, message) AS
    CASE WHEN NOT condition THEN error(message) END;

-- 3. Merge entities (keep earliest created_at)
BEGIN TRANSACTION;

INSERT INTO dest_db.entities (name, entityType, created_at)
SELECT s.name, s.entityType, s.created_at 
FROM source_db.entities s
ON CONFLICT (name) DO UPDATE SET
    entityType = EXCLUDED.entityType,
    created_at = CASE 
        WHEN entities.created_at <= EXCLUDED.created_at 
        THEN entities.created_at 
        ELSE EXCLUDED.created_at 
    END;

-- Verify entities merged
SELECT assert(
    (SELECT COUNT(*) FROM dest_db.entities) >= 
    (SELECT COUNT(DISTINCT name) FROM source_db.entities),
    'Entity count mismatch after merge'
);

COMMIT;

-- 4. Merge observations (union all unique)
BEGIN TRANSACTION;

INSERT INTO dest_db.observations (entityName, content, created_at)
SELECT entityName, content, created_at 
FROM source_db.observations
WHERE (entityName, content) NOT IN (
    SELECT entityName, content FROM dest_db.observations
);

COMMIT;

-- 5. Merge relations (keep earliest created_at)
BEGIN TRANSACTION;

INSERT INTO dest_db.relations (from_entity, to_entity, relationType, created_at)
SELECT from_entity, to_entity, relationType, created_at 
FROM source_db.relations
ON CONFLICT (from_entity, to_entity, relationType) DO UPDATE SET
    created_at = CASE 
        WHEN relations.created_at <= EXCLUDED.created_at 
        THEN relations.created_at 
        ELSE EXCLUDED.created_at 
    END;

COMMIT;

-- 6. Verify referential integrity
SELECT assert(
    (SELECT COUNT(*) FROM dest_db.observations o 
     WHERE NOT EXISTS (SELECT 1 FROM dest_db.entities e WHERE e.name = o.entityName)) = 0,
    'Orphaned observations found'
);

SELECT assert(
    (SELECT COUNT(*) FROM dest_db.relations r 
     WHERE NOT EXISTS (SELECT 1 FROM dest_db.entities e WHERE e.name = r.from_entity)
        OR NOT EXISTS (SELECT 1 FROM dest_db.entities e WHERE e.name = r.to_entity)) = 0,
    'Invalid relations found'
);

-- 7. Cleanup
DETACH source_db;
```

## Knowledge Graph Specific Implementation

### Handling Duplicate Prevention with DISTINCT ON

When merging might create duplicates within a single operation:

```sql
-- Prevent duplicate key errors when source has duplicates
INSERT INTO dest_db.entities (name, entityType, created_at)
SELECT DISTINCT ON (name) name, entityType, created_at
FROM source_db.entities
ORDER BY name, created_at  -- Ensures we get the earliest created_at
ON CONFLICT (name) DO UPDATE SET
    entityType = EXCLUDED.entityType,
    created_at = CASE 
        WHEN entities.created_at <= EXCLUDED.created_at 
        THEN entities.created_at 
        ELSE EXCLUDED.created_at 
    END;
```

### Memory-Efficient Merge for Large Graphs

For very large knowledge graphs, use a streaming approach:

```sql
-- Create temporary merged database
ATTACH ':memory:' AS temp_db;

-- Copy schema
COPY FROM DATABASE dest_db TO temp_db (SCHEMA);

-- Stream entities with deduplication
INSERT INTO temp_db.entities
SELECT name, 
       FIRST(entityType) as entityType, 
       MIN(created_at) as created_at
FROM (
    SELECT * FROM dest_db.entities
    UNION ALL
    SELECT * FROM source_db.entities
) combined
GROUP BY name;

-- Replace original with merged
COPY FROM DATABASE temp_db TO dest_db;
DETACH temp_db;
```

## Best Practices Summary

1. **Always use transactions** for atomic operations
2. **Attach databases** rather than copying data through intermediate files when possible
3. **Use INSERT OR REPLACE** for simple full-row replacement scenarios
4. **Use ON CONFLICT DO UPDATE** when you need selective column updates
5. **Batch large operations** to balance memory usage and performance
6. **Verify data integrity** with assertions before committing
7. **Handle referential integrity** explicitly for related tables
8. **Use DISTINCT ON** to handle potential duplicates in source data
9. **Consider COPY statement** for very large data transfers
10. **Test merge strategy** on sample data before running on production databases

## Error Handling Checklist

- [ ] Check for duplicate primary keys before merge
- [ ] Verify foreign key constraints will be maintained
- [ ] Ensure timestamp columns are properly handled
- [ ] Validate data types match between databases
- [ ] Test rollback scenarios
- [ ] Monitor memory usage for large merges
- [ ] Backup destination database before merge