import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// アプリケーション内で使用するログレベル
export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warning",
  ERROR = "error",
}

// LogLevelからMcpLogLevelへの変換マップ
const logLevelToMcpLogLevel = {
  [LogLevel.DEBUG]: "debug",
  [LogLevel.INFO]: "info",
  [LogLevel.WARN]: "warning",
  [LogLevel.ERROR]: "error",
} as const;

// 文字列からLogLevelへの変換関数
export function stringToLogLevel(level: string): LogLevel {
  switch (level.toLowerCase()) {
    case "debug":
      return LogLevel.DEBUG;
    case "info":
      return LogLevel.INFO;
    case "warning":
    case "warn":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO; // デフォルトはINFO
  }
}

// ログデータの型定義
export interface LogData {
  message: string;
  payload?: Record<string, unknown>;
}

// Nullロガー
export class NullLogger implements Logger {
  debug(message: string, payload?: Record<string, unknown>): void {
    // No-op
  }

  info(message: string, payload?: Record<string, unknown>): void {
    // No-op
  }

  warn(message: string, payload?: Record<string, unknown>): void {
    // No-op
  }

  error(message: string, payload?: Record<string, unknown>): void {
    // No-op
  }

  setLevel(level: LogLevel): void {
    // No-op
  }
}

// 抽象ロガーインターフェース
export interface Logger {
  debug(message: string, payload?: Record<string, unknown>): void;
  info(message: string, payload?: Record<string, unknown>): void;
  warn(message: string, payload?: Record<string, unknown>): void;
  error(message: string, payload?: Record<string, unknown>): void;
  setLevel(level: LogLevel): void;
}

// コンソールロガー（デフォルト実装として）
export class ConsoleLogger implements Logger {
  private level: LogLevel = LogLevel.INFO;
  private prefix(): string {
    return new Date().toISOString();
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, payload?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      if (payload !== undefined) {
        console.debug(`[${this.prefix()}] ${message}`, payload);
      } else {
        console.debug(`[${this.prefix()}] ${message}`);
      }
    }
  }

  info(message: string, payload?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.INFO)) {
      if (payload !== undefined) {
        console.info(`[${this.prefix()}] ${message}`, payload);
      } else {
        console.info(`[${this.prefix()}] ${message}`);
      }
    }
  }

  warn(message: string, payload?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.WARN)) {
      if (payload !== undefined) {
        console.warn(`[${this.prefix()}] ${message}`, payload);
      } else {
        console.warn(`[${this.prefix()}] ${message}`);
      }
    }
  }

  error(message: string, payload?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      if (payload !== undefined) {
        console.error(`[${this.prefix()}] ${message}`, payload);
      } else {
        console.error(`[${this.prefix()}] ${message}`);
      }
    }
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    const levels = [
      LogLevel.DEBUG,
      LogLevel.INFO,
      LogLevel.WARN,
      LogLevel.ERROR,
    ];
    return levels.indexOf(messageLevel) >= levels.indexOf(this.level);
  }
}

// Default logger instance
export const logger = new ConsoleLogger();

// Set debug level if DEBUG environment variable is set
if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
  logger.setLevel(LogLevel.DEBUG);
}
