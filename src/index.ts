#!/usr/bin/env node
import { getServerConfig, validateServerConfig, printServerConfig } from "./config/server-config";
import { MainServer } from "./servers/main-server";
import { SecondaryServer } from "./servers/secondary-server";
import { ConsoleLogger } from "./logger";
import { extractError } from "./utils";

/**
 * Main entry point that starts either main or secondary server based on configuration
 */
async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  
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