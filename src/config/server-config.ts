import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

/**
 * Server operation modes
 */
export type ServerMode = "main" | "secondary";

/**
 * Server configuration interface
 */
export interface ServerConfig {
  mode: ServerMode;
  database: {
    path: string;
  };
  ipc: {
    socketPath: string;
  };
  queue: {
    maxSize: number;
    timeoutMs: number;
  };
  search: {
    entityCountThreshold: number;
  };
  output?: {
    compact: boolean;
    includeObservations: boolean;
    maxEntities: number;
    maxObservationsPerEntity: number;
    snippetChars: number;
    includeRelations: 'none' | 'subset' | 'all';
    maxRelations: number;
    maxResponseChars: number;
  };
}

/**
 * Safe environment parsers
 */
function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(value)) return true;
  if (["false", "0", "no", "n"].includes(value)) return false;
  // Fallback to default on unknown value
  console.warn(`[server-config] Invalid boolean for ${name}='${raw}', using default=${defaultValue}`);
  return defaultValue;
}

function parsePositiveIntEnv(
  name: string,
  defaultValue: number,
  options?: { allowZero?: boolean }
): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`[server-config] Invalid integer for ${name}='${raw}', using default=${defaultValue}`);
    return defaultValue;
  }
  if (options?.allowZero) {
    if (parsed < 0) {
      console.warn(`[server-config] Negative value for ${name}=${parsed}, using default=${defaultValue}`);
      return defaultValue;
    }
    return parsed;
  }
  if (parsed <= 0) {
    console.warn(`[server-config] Non-positive value for ${name}=${parsed}, using default=${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseIncludeRelationsEnv(
  name: string,
  defaultValue: 'none' | 'subset' | 'all'
): 'none' | 'subset' | 'all' {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  const value = raw.trim().toLowerCase();
  if (value === 'none' || value === 'subset' || value === 'all') return value;
  console.warn(`[server-config] Invalid includeRelations for ${name}='${raw}', using default='${defaultValue}'`);
  return defaultValue;
}

/**
 * Get server configuration from environment variables and defaults
 */
export function getServerConfig(): ServerConfig {
  const mode = getServerMode();
  const databasePath = getDatabasePath();
  const socketPath = getSocketPath();

  return {
    mode,
    database: {
      path: databasePath,
    },
    ipc: {
      socketPath,
    },
    queue: {
      maxSize: parsePositiveIntEnv('QUEUE_MAX_SIZE', 100),
      timeoutMs: parsePositiveIntEnv('QUEUE_TIMEOUT_MS', 30000),
    },
    search: {
      entityCountThreshold: parsePositiveIntEnv('ENTITY_COUNT_THRESHOLD', 1000, { allowZero: true }),
    },
    output: {
      compact: parseBooleanEnv('OUTPUT_COMPACT', true),
      includeObservations: parseBooleanEnv('OUTPUT_INCLUDE_OBSERVATIONS', false),
      maxEntities: parsePositiveIntEnv('OUTPUT_MAX_ENTITIES', 20),
      maxObservationsPerEntity: parsePositiveIntEnv('OUTPUT_MAX_OBS_PER_ENTITY', 3, { allowZero: true }),
      snippetChars: parsePositiveIntEnv('OUTPUT_SNIPPET_CHARS', 280),
      includeRelations: parseIncludeRelationsEnv('OUTPUT_INCLUDE_RELATIONS', 'subset'),
      maxRelations: parsePositiveIntEnv('OUTPUT_MAX_RELATIONS', 200, { allowZero: true }),
      maxResponseChars: parsePositiveIntEnv('RESPONSE_MAX_CHARS', 50000),
    },
  };
}

/**
 * Determine server mode from environment variables or command line arguments
 */
function getServerMode(): ServerMode {
  // Check environment variable first
  const envMode = process.env.SERVER_MODE?.toLowerCase();
  if (envMode === "main" || envMode === "secondary") {
    return envMode;
  }

  // Check command line arguments
  const args = process.argv;
  const modeArgIndex = args.findIndex(arg => arg === "--mode");
  if (modeArgIndex !== -1 && modeArgIndex + 1 < args.length) {
    const argMode = args[modeArgIndex + 1].toLowerCase();
    if (argMode === "main" || argMode === "secondary") {
      return argMode;
    }
  }

  // Check for direct mode flags
  if (args.includes("--main")) {
    return "main";
  }
  if (args.includes("--secondary")) {
    return "secondary";
  }

  // Default to main mode
  return "main";
}

/**
 * Get database file path
 */
function getDatabasePath(): string {
  if (process.env.MEMORY_FILE_PATH) {
    return process.env.MEMORY_FILE_PATH;
  }

  // Default path: ~/.local/share/duckdb-memory-server/knowledge-graph.data
  const defaultDir = join(homedir(), ".local", "share", "duckdb-memory-server");
  const defaultPath = join(defaultDir, "knowledge-graph.data");

  // Create directory if it doesn't exist
  if (!existsSync(dirname(defaultPath))) {
    mkdirSync(dirname(defaultPath), { recursive: true });
  }

  return defaultPath;
}

/**
 * Get IPC socket path
 */
function getSocketPath(): string {
  if (process.env.IPC_SOCKET_PATH) {
    return process.env.IPC_SOCKET_PATH;
  }

  // Default socket path
  const defaultDir = join(homedir(), ".local", "share", "duckdb-memory-server");
  const defaultSocketPath = join(defaultDir, "main-server.sock");

  // Create directory if it doesn't exist
  if (!existsSync(dirname(defaultSocketPath))) {
    mkdirSync(dirname(defaultSocketPath), { recursive: true });
  }

  return defaultSocketPath;
}

/**
 * Validate server configuration
 */
export function validateServerConfig(config: ServerConfig): void {
  if (!config.mode || !["main", "secondary"].includes(config.mode)) {
    throw new Error(`Invalid server mode: ${config.mode}`);
  }

  if (!config.database.path) {
    throw new Error("Database path is required");
  }

  if (!config.ipc.socketPath) {
    throw new Error("IPC socket path is required");
  }

  if (config.queue.maxSize <= 0) {
    throw new Error("Queue max size must be positive");
  }

  if (config.queue.timeoutMs <= 0) {
    throw new Error("Queue timeout must be positive");
  }

  if (config.search.entityCountThreshold < 0) {
    throw new Error("Entity count threshold must be non-negative");
  }

  // Optional output validation
  if (config.output) {
    const o = config.output;
    if (o.maxEntities != null && o.maxEntities <= 0) {
      throw new Error("output.maxEntities must be positive if provided");
    }
    if (o.maxObservationsPerEntity != null && o.maxObservationsPerEntity < 0) {
      throw new Error("output.maxObservationsPerEntity must be non-negative if provided");
    }
    if (o.snippetChars != null && o.snippetChars <= 0) {
      throw new Error("output.snippetChars must be positive if provided");
    }
    if (o.maxRelations != null && o.maxRelations < 0) {
      throw new Error("output.maxRelations must be non-negative if provided");
    }
    if (o.maxResponseChars != null && o.maxResponseChars <= 0) {
      throw new Error("output.maxResponseChars must be positive if provided");
    }
    if (o.includeRelations != null && !["none", "subset", "all"].includes(o.includeRelations)) {
      throw new Error("output.includeRelations must be one of 'none' | 'subset' | 'all'");
    }
  }
}

/**
 * Print server configuration for debugging
 */
export function printServerConfig(config: ServerConfig): void {
  console.log("Server Configuration:");
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Database Path: ${config.database.path}`);
  console.log(`  IPC Socket Path: ${config.ipc.socketPath}`);
  console.log(`  Queue Max Size: ${config.queue.maxSize}`);
  console.log(`  Queue Timeout: ${config.queue.timeoutMs}ms`);
  console.log(`  Entity Count Threshold: ${config.search.entityCountThreshold}`);
}