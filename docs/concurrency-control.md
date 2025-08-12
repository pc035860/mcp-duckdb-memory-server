# Concurrency Control Implementation

## Overview

This document describes the comprehensive concurrency control mechanism implemented in the MCP DuckDB Memory Server to prevent race conditions, particularly between deletion operations and FTS index rebuilds.

## Problem Statement

The system was experiencing race conditions between:
- Deletion operations and FTS index rebuilds
- Multiple concurrent bulk write operations
- Database migrations and other operations
- FTS index rebuilds triggered by different data changes

These race conditions could lead to:
- Database corruption
- Failed operations
- Inconsistent state
- Performance degradation

## Solution Architecture

### 1. Centralized Concurrency Controller

We implemented a `ConcurrencyController` class that manages all operation synchronization:

```typescript
export class ConcurrencyController {
  // Manages operation states, queuing, and conflict resolution
}
```

Key features:
- **Operation Types**: `migration`, `ftsRebuild`, `deletion`, `bulkWrite`
- **Priority System**: Migration > Deletion > BulkWrite > FTS Rebuild
- **Conflict Matrix**: Defines which operations conflict with each other
- **Queue Management**: Serializes operations with timeout support

### 2. Operation Priorities

Operations are executed based on priority to ensure critical operations complete first:

| Operation | Priority | Description |
|-----------|----------|-------------|
| Migration | 0 | Database schema changes (highest priority) |
| Deletion | 1 | Entity deletion operations |
| BulkWrite | 2 | Create/update operations |
| FTS Rebuild | 3 | Index maintenance (lowest priority) |

### 3. Conflict Resolution

The system defines which operations conflict with each other:

```typescript
const CONFLICTS = {
  migration: ['ftsRebuild', 'deletion', 'bulkWrite'],
  deletion: ['migration', 'ftsRebuild'],
  bulkWrite: ['migration', 'ftsRebuild'],
  ftsRebuild: ['migration', 'deletion', 'bulkWrite']
}
```

Conflicting operations wait for each other to complete before proceeding.

### 4. Integration Points

#### DuckDBManager Integration

The `DuckDBKnowledgeGraphManager` uses the concurrency controller for all critical operations:

```typescript
// Example: Delete operation with concurrency control
async deleteEntities(entityNames: string[]): Promise<void> {
  return this.executeWithConcurrencyControl('deletion', async () => {
    // Actual deletion logic
  });
}
```

#### ProxyManager Integration

The `ProxyKnowledgeGraphManager` (secondary server) also implements local concurrency control:

```typescript
// Ensures operations are serialized at the secondary server level
private async executeWithConcurrencyControl<T>(
  operation: () => Promise<T>
): Promise<T> {
  // Local queue management
}
```

## Implementation Details

### Operation Queue

- **Max Queue Size**: 100 operations (configurable)
- **Operation Timeout**: 60 seconds (configurable)
- **Processing**: Sequential execution based on priority and enqueue time

### State Tracking

Each operation type has its state tracked:
- `inProgress`: Boolean indicating if operation is currently executing
- `startTime`: Timestamp when operation started
- `promise`: Reference to the operation promise for waiting

### Error Handling

- Failed operations don't affect other queued operations
- Timeout handling for operations that take too long
- Graceful degradation when concurrency control fails

## Benefits

1. **Prevents Race Conditions**: Operations are properly serialized
2. **Maintains Data Integrity**: No concurrent modifications to same resources
3. **Improved Reliability**: System handles high concurrency gracefully
4. **Better Performance**: Priority system ensures critical operations complete first
5. **Diagnostic Capabilities**: Operation status monitoring for debugging

## Usage Examples

### Monitoring Operation Status

```typescript
const status = manager.getOperationStatus();
console.log('Current operations:', status.states);
console.log('Queue length:', status.queueLength);
console.log('Queue stats:', status.queueStats);
```

### Handling Concurrent Operations

```typescript
// These operations will be automatically serialized
const operations = Promise.all([
  manager.deleteEntities(['entity1']),
  manager.createEntities([...]),
  manager.rebuildFTSIndexes()
]);

// All complete without conflicts
await operations;
```

## Testing

The implementation includes comprehensive tests:

1. **Unit Tests** (`concurrency-control.test.ts`):
   - Operation serialization
   - Priority management
   - Conflict detection
   - Queue management
   - Error recovery

2. **Integration Tests** (`concurrency-integration.test.ts`):
   - Real-world scenarios
   - Mixed operations
   - FTS coordination
   - Error recovery

## Future Improvements

Potential enhancements for the concurrency control system:

1. **Read/Write Locks**: Separate read and write operations for better concurrency
2. **Resource-Level Locking**: Lock specific entities rather than operation types
3. **Distributed Locking**: Support for multi-instance deployments
4. **Performance Metrics**: Track operation execution times and queue wait times
5. **Dynamic Priority Adjustment**: Adjust priorities based on system load

## Configuration

The concurrency controller can be configured with:

```typescript
new ConcurrencyController(
  logger,           // Logger instance
  maxQueueSize,     // Maximum operations in queue (default: 100)
  operationTimeout  // Operation timeout in ms (default: 60000)
);
```

## Troubleshooting

### Common Issues

1. **Operations Timing Out**
   - Increase `operationTimeout` configuration
   - Check for deadlocks in operation logic

2. **Queue Full Errors**
   - Increase `maxQueueSize` configuration
   - Reduce concurrent operation submissions

3. **Performance Degradation**
   - Monitor queue length with `getOperationStatus()`
   - Check for long-running operations blocking the queue

### Debug Logging

Enable debug logging to see detailed operation flow:

```bash
DEBUG=1 pnpm start
```

This will show:
- Operation enqueueing
- Conflict waiting
- Operation completion times
- Queue processing status