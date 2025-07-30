import { DuckDBKnowledgeGraphManager } from "../managers/duckdb-manager";
import { IPCSocketServer } from "./ipc/socket-server";
import { RequestQueue } from "../queue/request-queue";
import { ServerConfig } from "../config/server-config";
import { Logger, ConsoleLogger } from "../logger";
import { extractError } from "../utils";
import { unlinkSync, existsSync } from "fs";
import {
  IPCRequest,
  isCreateEntitiesRequest,
  isCreateRelationsRequest,
  isAddObservationsRequest,
  isDeleteEntitiesRequest,
  isDeleteObservationsRequest,
  isDeleteRelationsRequest,
  isSearchNodesRequest,
  isSearchMultiKeywordsRequest,
  isOpenNodesRequest,
  isReadGraphRequest,
  isCheckpointRequest,
  isRebuildFTSIndexesRequest,
  isCheckFTSIndexHealthRequest,
  isGetFTSInfoRequest,
  validateSearchNodesRequest,
  validateSearchMultiKeywordsRequest,
} from "./ipc/protocol";

/**
 * Main server that owns the DuckDB instance and processes all requests
 */
export class MainServer {
  private manager: DuckDBKnowledgeGraphManager;
  private ipcServer: IPCSocketServer;
  private requestQueue: RequestQueue<IPCRequest>;
  private config: ServerConfig;
  private logger: Logger;
  private running: boolean = false;

  constructor(config: ServerConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger || new ConsoleLogger();
    
    // Initialize DuckDB manager
    this.manager = new DuckDBKnowledgeGraphManager(
      () => config.database.path,
      this.logger,
      false, // allowExternalTimestamps
      config.search.entityCountThreshold
    );

    // Initialize request queue
    this.requestQueue = new RequestQueue<IPCRequest>(
      this.handleRequest.bind(this),
      config.queue.maxSize,
      config.queue.timeoutMs,
      this.logger
    );

    // Initialize IPC server
    this.ipcServer = new IPCSocketServer(
      this.logger,
      this.enqueueRequest.bind(this)
    );
  }

  /**
   * Start the main server
   */
  async start(): Promise<void> {
    try {
      this.logger.info("Starting Main Server...");

      // Clean up existing socket file if it exists
      if (existsSync(this.config.ipc.socketPath)) {
        try {
          unlinkSync(this.config.ipc.socketPath);
          this.logger.info("Removed existing socket file");
        } catch (error) {
          this.logger.warn("Could not remove existing socket file", extractError(error));
        }
      }

      // Initialize DuckDB manager
      await this.manager.initialize();
      this.logger.info("DuckDB manager initialized");

      // Start IPC server
      await this.ipcServer.start(this.config.ipc.socketPath);
      this.logger.info("IPC server started");

      this.running = true;
      this.logger.info("Main Server started successfully", {
        socketPath: this.config.ipc.socketPath,
        databasePath: this.config.database.path
      });

    } catch (error) {
      this.logger.error("Failed to start Main Server", extractError(error));
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the main server
   */
  async stop(): Promise<void> {
    this.logger.info("Stopping Main Server...");
    this.running = false;

    try {
      // Stop IPC server
      await this.ipcServer.stop();
      this.logger.info("IPC server stopped");

      // Clear request queue
      this.requestQueue.clear();
      this.logger.info("Request queue cleared");

      // Close DuckDB manager
      await this.manager.close();
      this.logger.info("DuckDB manager closed");

      // Clean up socket file
      if (existsSync(this.config.ipc.socketPath)) {
        try {
          unlinkSync(this.config.ipc.socketPath);
          this.logger.info("Socket file removed");
        } catch (error) {
          this.logger.warn("Could not remove socket file", extractError(error));
        }
      }

      this.logger.info("Main Server stopped successfully");
    } catch (error) {
      this.logger.error("Error stopping Main Server", extractError(error));
      throw error;
    }
  }

  /**
   * Enqueue request for processing
   */
  private async enqueueRequest(request: IPCRequest): Promise<any> {
    if (!this.running) {
      throw new Error("Main server is not running");
    }

    return await this.requestQueue.enqueue(request.id, request);
  }

  /**
   * Handle individual request
   */
  private async handleRequest(request: IPCRequest): Promise<any> {
    try {
      if (isCreateEntitiesRequest(request)) {
        return await this.manager.createEntities(request.payload.entities);
      }

      if (isCreateRelationsRequest(request)) {
        return await this.manager.createRelations(request.payload.relations);
      }

      if (isAddObservationsRequest(request)) {
        return await this.manager.addObservations(request.payload.observations);
      }

      if (isDeleteEntitiesRequest(request)) {
        await this.manager.deleteEntities(request.payload.entityNames);
        return { success: true };
      }

      if (isDeleteObservationsRequest(request)) {
        await this.manager.deleteObservations(request.payload.deletions);
        return { success: true };
      }

      if (isDeleteRelationsRequest(request)) {
        await this.manager.deleteRelations(request.payload.relations);
        return { success: true };
      }

      if (isSearchNodesRequest(request)) {
        // Validate request payload including time range options
        validateSearchNodesRequest(request.payload);
        return await this.manager.searchNodes(request.payload.query, request.payload.options);
      }

      if (isSearchMultiKeywordsRequest(request)) {
        // Validate request payload including time range options  
        validateSearchMultiKeywordsRequest(request.payload);
        return await this.manager.searchMultiKeywords(
          request.payload.keywords,
          request.payload.options
        );
      }

      if (isOpenNodesRequest(request)) {
        return await this.manager.openNodes(request.payload.names);
      }

      if (isReadGraphRequest(request)) {
        return await this.manager.readGraph();
      }

      if (isCheckpointRequest(request)) {
        await this.manager.checkpoint();
        return { success: true, message: "Checkpoint completed successfully" };
      }

      if (isRebuildFTSIndexesRequest(request)) {
        await this.manager.rebuildFTSIndexes();
        return { success: true, message: "FTS indexes rebuilt successfully" };
      }

      if (isCheckFTSIndexHealthRequest(request)) {
        return await this.manager.checkFTSIndexHealth();
      }

      if (isGetFTSInfoRequest(request)) {
        return await this.manager.getFTSInfo();
      }

      throw new Error(`Unknown request type: ${(request as any).type}`);
    } catch (error) {
      this.logger.error("Error handling request", {
        type: (request as any).type,
        id: (request as any).id,
        error: extractError(error)
      });
      throw error;
    }
  }

  /**
   * Get server status
   */
  getStatus(): {
    running: boolean;
    queueStats: ReturnType<RequestQueue<IPCRequest>["getStats"]>;
    config: ServerConfig;
  } {
    return {
      running: this.running,
      queueStats: this.requestQueue.getStats(),
      config: this.config,
    };
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }
}