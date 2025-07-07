# DuckDB Instance Lifecycle Management

## Overview

This document describes the DuckDB instance lifecycle management implementation in the mcp-duckdb-memory-server project, including the design decisions, technical details, and lessons learned.

## Background

The original implementation reused a single DuckDB instance across all MCP tool operations. This approach led to potential memory accumulation issues, as the instance would hold onto resources indefinitely. To address this, we implemented a new strategy where each MCP tool operation uses a fresh DuckDB instance that is cleaned up after completion.

## Implementation Details

### Core Changes

#### 1. Instance Cleanup Method

```typescript
private async cleanupInstance(): Promise<void> {
  if (this.instance) {
    try {
      // Execute CHECKPOINT to ensure data is written to disk
      const conn = await this.instance.connect();
      await conn.run("CHECKPOINT");
      conn.close();
    } catch (error) {
      this.logger.error("Error during checkpoint", extractError(error));
    }
  }
  this.instance = null as any;
  this.initialized = false;
}
```

The `cleanupInstance()` method:
- Executes a `CHECKPOINT` command to flush WAL (Write-Ahead Log) to disk
- Closes the connection properly
- Nullifies the instance reference
- Resets the initialization flag

#### 2. Operation Pattern

Each public method follows this pattern:

```typescript
async someOperation() {
  try {
    // Perform database operations
    using conn = await this.getConn();
    // ... execute queries ...
    
    // Clean up instance after operation
    await this.cleanupInstance();
    
    return result;
  } catch (error) {
    // Clean up instance on error
    await this.cleanupInstance();
    throw error;
  }
}
```

### Key Concepts

#### 1. DuckDB Instance vs Connection

- **Instance**: Heavy-weight resource representing the database
- **Connection**: Light-weight resource for executing queries
- One instance can have multiple connections
- Creating instances is expensive, creating connections is cheap

#### 2. Concurrency Limitations

DuckDB has specific concurrency constraints:
- **Write operations are serialized**: Only one write transaction at a time
- **Read operations can be concurrent**: Multiple readers are allowed
- **No concurrent write operations**: This is enforced at the database level

#### 3. WAL (Write-Ahead Logging)

DuckDB uses WAL for performance:
- Writes go to WAL file first, not directly to the main database
- CHECKPOINT command flushes WAL to the main database file
- Without CHECKPOINT, data might not persist when instance is destroyed

## Technical Considerations

### Memory Management

The new approach trades performance for memory efficiency:
- **Pros**: Prevents memory accumulation, ensures clean state
- **Cons**: Instance creation overhead on each operation

### Data Persistence

Critical for data persistence:
- Always execute `CHECKPOINT` before instance cleanup
- Ensures WAL changes are written to disk
- Prevents data loss between operations

### Error Handling

Proper cleanup in all code paths:
- Cleanup in try block after successful operation
- Cleanup in catch block for error cases
- Ensures resources are released regardless of outcome

## File Structure

DuckDB creates several files:
- `*.db` - Main database file
- `*.db.wal` - Write-Ahead Log file
- `*.db.lockfile` - Lock file for process coordination

## Best Practices

1. **Always use `using` syntax for connections**
   ```typescript
   using conn = await this.getConn();
   ```

2. **Execute CHECKPOINT before cleanup**
   - Ensures data persistence
   - Prevents WAL-related data loss

3. **Handle cleanup in all paths**
   - Success path
   - Error path
   - Early return path

4. **Test with clean state**
   - Each test should start fresh
   - Clean up test files after each test

## Performance Impact

The instance-per-operation approach has performance implications:
- **Instance creation**: ~10-50ms overhead per operation
- **CHECKPOINT execution**: ~5-20ms depending on data size
- **Total overhead**: ~15-70ms per operation

This overhead is acceptable for MCP tool operations which are typically not high-frequency.

## Migration Notes

When migrating from persistent instance to per-operation instance:

1. **Update all public methods**: Add `await this.cleanupInstance()`
2. **Make cleanup async**: Change from sync to async method
3. **Update all cleanup calls**: Add `await` keyword
4. **Test data persistence**: Ensure data survives between operations

## Common Issues and Solutions

### Issue 1: Data not persisting between operations
**Solution**: Ensure CHECKPOINT is executed before cleanup

### Issue 2: Test failures due to missing data
**Solution**: Understand that each operation now has isolated instance

### Issue 3: Connection already closed errors
**Solution**: Check that cleanup isn't called multiple times

## Code Examples

### Before (Persistent Instance)
```typescript
async createEntities(entities: Entity[]): Promise<Entity[]> {
  using conn = await this.getConn();
  // ... perform operations ...
  return createdEntities;
}
```

### After (Instance Per Operation)
```typescript
async createEntities(entities: Entity[]): Promise<Entity[]> {
  try {
    using conn = await this.getConn();
    // ... perform operations ...
    
    await this.cleanupInstance();
    return createdEntities;
  } catch (error) {
    await this.cleanupInstance();
    throw error;
  }
}
```

## References

- [DuckDB Node.js API Documentation](https://duckdb.org/docs/api/nodejs)
- [@duckdb/node-api npm package](https://www.npmjs.com/package/@duckdb/node-api)
- [DuckDB Concurrency Model](https://duckdb.org/docs/connect/concurrency)

## Conclusion

The instance-per-operation approach successfully addresses memory accumulation issues while maintaining data integrity. The performance overhead is acceptable for the use case, and the implementation ensures proper resource cleanup and data persistence.