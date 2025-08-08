#!/usr/bin/env node
import { getServerConfig, validateServerConfig, printServerConfig } from "./config/server-config";
import { MainServer } from "./servers/main-server";
import { SecondaryServer } from "./servers/secondary-server";
import { ConsoleLogger, LogLevel } from "./logger";
import { extractError } from "./utils";

/**
 * Main entry point that starts either main or secondary server based on configuration
 */
async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  
  // Set log level to DEBUG if DEBUG environment variable is set
  if (process.env.DEBUG === "1" || process.env.DEBUG?.toLowerCase() === "true") {
    logger.setLevel(LogLevel.DEBUG);
  }
  
  try {
    // Get and validate configuration
    const config = getServerConfig();
    validateServerConfig(config);

    // Print configuration for debugging
    if (process.env.DEBUG) {
      printServerConfig(config);
    }

    logger.info(`Starting server in ${config.mode} mode`);

    if (config.mode === "main") {
      // Start main server
      const mainServer = new MainServer(config, logger);
      
      // Handle graceful shutdown
      const shutdown = async () => {
        logger.info("Received shutdown signal");
        try {
          await mainServer.stop();
          process.exit(0);
        } catch (error) {
          logger.error("Error during shutdown", extractError(error));
          process.exit(1);
        }
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("SIGUSR2", shutdown); // nodemon restart

      await mainServer.start();
      logger.info("Main server is running. Press Ctrl+C to stop.");
      
    } else {
      // Start secondary server (MCP proxy)
      const secondaryServer = new SecondaryServer(config, logger);
      
      // Handle graceful shutdown
      const shutdown = async () => {
        logger.info("Received shutdown signal");
        try {
          await secondaryServer.stop();
          process.exit(0);
        } catch (error) {
          logger.error("Error during shutdown", extractError(error));
          process.exit(1);
        }
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("SIGUSR2", shutdown); // nodemon restart

      // Treat stdio closure as shutdown trigger (MCP client lifecycle)
      // Ensure Node keeps stdin open to receive 'end'/'close'
      try {
        process.stdin.resume();
      } catch {
        // ignore if already flowing
      }

      const onStdioClosed = () => {
        logger.info("Stdio closed - triggering shutdown");
        // Use next tick to avoid re-entrancy if called during stream callback
        setImmediate(() => void shutdown());
      };

      process.stdin.on("end", onStdioClosed);
      process.stdin.on("close", onStdioClosed);

      // When MCP client closes stdout, writes may emit EPIPE
      process.stdout.on("error", (err: any) => {
        const code = (err && (err as any).code) as string | undefined;
        if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
          onStdioClosed();
        }
      });

      await secondaryServer.start();
      logger.info("Secondary server is running and connected to stdio");
    }

  } catch (error) {
    logger.error("Failed to start server", extractError(error));
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

// Start the application
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});