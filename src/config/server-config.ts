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
      maxSize: parseInt(process.env.QUEUE_MAX_SIZE || "100", 10),
      timeoutMs: parseInt(process.env.QUEUE_TIMEOUT_MS || "30000", 10),
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
}