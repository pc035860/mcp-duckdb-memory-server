import { Socket } from "net";
import { IPCRequest, IPCResponse, generateRequestId } from "./protocol";
import { Logger } from "../../logger";
import { extractError } from "../../utils";

/**
 * IPC Client for connecting to main server
 */
export class IPCSocketClient {
  private socket: Socket | null = null;
  private connected: boolean = false;
  private pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private logger: Logger;
  private socketPath: string;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private buffer: string = "";
  private maxRetries: number = 5;
  private retryCount: number = 0;
  private baseDelay: number = 1000; // 1 second

  constructor(socketPath: string, logger: Logger) {
    this.socketPath = socketPath;
    this.logger = logger;
  }

  /**
   * Connect to the main server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      this.socket = new Socket();

      this.socket.on("connect", () => {
        this.connected = true;
        this.retryCount = 0; // Reset retry count on successful connection
        this.logger.info("Connected to main server via IPC");
        
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
        
        resolve();
      });

      this.socket.on("data", (data) => {
        this.handleData(data);
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.logger.warn("IPC connection closed");
        this.handleDisconnection();
      });

      this.socket.on("error", (error) => {
        this.connected = false;
        this.logger.error("IPC connection error", extractError(error));
        this.handleDisconnection();
        reject(error);
      });

      this.socket.connect(this.socketPath);
    });
  }

  /**
   * Disconnect from the main server
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Reject all pending requests
    for (const [id, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    this.connected = false;
    this.logger.info("Disconnected from main server");
  }

  /**
   * Send request to main server
   */
  async sendRequest<T = any>(request: Omit<IPCRequest, "id">): Promise<T> {
    if (!this.connected) {
      await this.connect();
    }

    const fullRequest: IPCRequest = {
      ...request,
      id: generateRequestId(),
    } as IPCRequest;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(fullRequest.id);
        reject(new Error(`Request timeout: ${fullRequest.type}`));
      }, 30000); // 30 second timeout

      this.pendingRequests.set(fullRequest.id, {
        resolve,
        reject,
        timeout,
      });

      try {
        const message = JSON.stringify(fullRequest) + "\n";
        this.socket!.write(message);
        this.logger.info("Sent IPC request", { type: fullRequest.type, id: fullRequest.id });
      } catch (error) {
        this.pendingRequests.delete(fullRequest.id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming data from server
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();
    
    // Process complete messages (newline-delimited JSON)
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const message = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      
      if (message.trim()) {
        this.handleMessage(message);
      }
    }
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(message: string): void {
    try {
      const response: IPCResponse = JSON.parse(message);
      this.logger.info("Received IPC response", { id: response.id, success: response.success });

      const pendingRequest = this.pendingRequests.get(response.id);
      if (pendingRequest) {
        this.pendingRequests.delete(response.id);
        clearTimeout(pendingRequest.timeout);

        if (response.success) {
          pendingRequest.resolve(response.data);
        } else {
          pendingRequest.reject(new Error(response.error || "Unknown error"));
        }
      } else {
        this.logger.warn("Received response for unknown request", { id: response.id });
      }
    } catch (error) {
      this.logger.error("Error parsing IPC response", extractError(error));
    }
  }

  /**
   * Handle disconnection and attempt reconnection
   */
  private handleDisconnection(): void {
    // Reject all pending requests
    for (const [id, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error("Connection lost"));
    }
    this.pendingRequests.clear();

    // Attempt to reconnect with exponential backoff
    if (!this.reconnectTimeout && this.retryCount < this.maxRetries) {
      const delay = this.baseDelay * Math.pow(2, this.retryCount);
      this.retryCount++;
      
      this.reconnectTimeout = setTimeout(() => {
        this.logger.info(`Attempting to reconnect to main server (attempt ${this.retryCount}/${this.maxRetries})...`);
        this.connect().catch((error) => {
          this.logger.error("Reconnection failed", extractError(error));
          this.reconnectTimeout = null;
          this.handleDisconnection(); // Try again if within retry limit
        });
      }, delay);
    } else if (this.retryCount >= this.maxRetries) {
      this.logger.error(`Max reconnection attempts (${this.maxRetries}) reached. Giving up.`);
    }
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}