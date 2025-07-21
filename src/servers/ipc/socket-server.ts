import { createServer, Server, Socket } from "net";
import { IPCRequest, IPCResponse } from "./protocol";
import { Logger } from "../../logger";
import { extractError } from "../../utils";

/**
 * IPC Server for handling requests from secondary servers
 */
export class IPCSocketServer {
  private server: Server | null = null;
  private clients: Set<Socket> = new Set();
  private logger: Logger;
  private requestHandler: (request: IPCRequest) => Promise<any>;

  constructor(
    logger: Logger,
    requestHandler: (request: IPCRequest) => Promise<any>
  ) {
    this.logger = logger;
    this.requestHandler = requestHandler;
  }

  /**
   * Start the IPC server
   */
  async start(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleClientConnection(socket);
      });

      this.server.on("error", (error) => {
        this.logger.error("IPC Server error", extractError(error));
        reject(error);
      });

      this.server.listen(socketPath, () => {
        this.logger.info(`IPC Server listening on ${socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // Close all client connections
        for (const client of this.clients) {
          client.destroy();
        }
        this.clients.clear();

        this.server.close(() => {
          this.logger.info("IPC Server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle new client connection
   */
  private handleClientConnection(socket: Socket): void {
    this.clients.add(socket);
    this.logger.info("New IPC client connected");

    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      
      // Process complete messages (newline-delimited JSON)
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const message = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        
        if (message.trim()) {
          this.handleMessage(socket, message);
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      this.logger.info("IPC client disconnected");
    });

    socket.on("error", (error) => {
      this.logger.error("IPC client error", extractError(error));
      this.clients.delete(socket);
    });
  }

  /**
   * Handle incoming message from client
   */
  private async handleMessage(socket: Socket, message: string): Promise<void> {
    try {
      const request: IPCRequest = JSON.parse(message);
      this.logger.info("Received IPC request", { type: request.type, id: request.id });

      try {
        const result = await this.requestHandler(request);
        const response: IPCResponse = {
          id: request.id,
          success: true,
          data: result,
        };
        
        this.sendResponse(socket, response);
      } catch (error) {
        const response: IPCResponse = {
          id: request.id,
          success: false,
          error: extractError(error).message,
        };
        
        this.sendResponse(socket, response);
      }
    } catch (error) {
      this.logger.error("Error parsing IPC message", extractError(error));
      // Send error response if we can extract request ID
      try {
        const partialRequest = JSON.parse(message);
        if (partialRequest.id) {
          const response: IPCResponse = {
            id: partialRequest.id,
            success: false,
            error: "Invalid request format",
          };
          this.sendResponse(socket, response);
        }
      } catch {
        // Can't parse request ID, ignore
      }
    }
  }

  /**
   * Send response to client
   */
  private sendResponse(socket: Socket, response: IPCResponse): void {
    try {
      const message = JSON.stringify(response) + "\n";
      socket.write(message);
      this.logger.info("Sent IPC response", { id: response.id, success: response.success });
    } catch (error) {
      this.logger.error("Error sending IPC response", extractError(error));
    }
  }
}