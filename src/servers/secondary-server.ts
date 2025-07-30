import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProxyKnowledgeGraphManager } from "../managers/proxy-manager";
import { ServerConfig } from "../config/server-config";
import { Logger, ConsoleLogger } from "../logger";
import { extractError } from "../utils";
import { EntityObject, ObservationObject, RelationObject } from "../types";
import { SearchNodesOptionsSchema, MultiKeywordSearchOptionsSchema } from "../utils/time-validation-schemas";

/**
 * Secondary server that provides MCP interface and forwards requests to main server
 */
export class SecondaryServer {
  private mcpServer: McpServer;
  private manager: ProxyKnowledgeGraphManager;
  private config: ServerConfig;
  private logger: Logger;
  private running: boolean = false;

  constructor(config: ServerConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger || new ConsoleLogger();

    // Initialize proxy manager
    this.manager = new ProxyKnowledgeGraphManager(
      config.ipc.socketPath,
      this.logger
    );

    // Initialize MCP server
    this.mcpServer = new McpServer({
      name: "duckdb-memory-server",
      version: "1.1.2",
    });

    this.setupMCPTools();
  }

  /**
   * Setup MCP tools
   */
  private setupMCPTools(): void {
    // Create entities tool
    this.mcpServer.tool(
      "create_entities",
      "Create multiple new entities in the knowledge graph",
      {
        entities: z.array(EntityObject),
      },
      async ({ entities }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await this.manager.createEntities(entities),
              null,
              2
            ),
          },
        ],
      })
    );

    // Create relations tool
    this.mcpServer.tool(
      "create_relations",
      "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
      {
        relations: z.array(RelationObject),
      },
      async ({ relations }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await this.manager.createRelations(relations),
              null,
              2
            ),
          },
        ],
      })
    );

    // Add observations tool
    this.mcpServer.tool(
      "add_observations",
      "Add new observations to existing entities in the knowledge graph",
      {
        observations: z.array(ObservationObject),
      },
      async ({ observations }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await this.manager.addObservations(observations),
              null,
              2
            ),
          },
        ],
      })
    );

    // Delete entities tool
    this.mcpServer.tool(
      "delete_entities",
      "Delete multiple entities and their associated relations from the knowledge graph",
      {
        entityNames: z
          .array(z.string())
          .describe("An array of entity names to delete"),
      },
      async ({ entityNames }) => {
        await this.manager.deleteEntities(entityNames);
        return {
          content: [{ type: "text", text: "Entities deleted successfully" }],
        };
      }
    );

    // Delete observations tool
    this.mcpServer.tool(
      "delete_observations",
      "Delete specific observations from entities in the knowledge graph",
      {
        deletions: z.array(
          z.object({
            entityName: z
              .string()
              .describe("The name of the entity containing the observations"),
            contents: z
              .array(z.string())
              .describe("An array of observations to delete"),
          })
        ),
      },
      async ({ deletions }) => {
        await this.manager.deleteObservations(deletions);
        return {
          content: [{ type: "text", text: "Observations deleted successfully" }],
        };
      }
    );

    // Delete relations tool
    this.mcpServer.tool(
      "delete_relations",
      "Delete multiple relations from the knowledge graph",
      {
        relations: z
          .array(
            z.object({
              from: z
                .string()
                .describe("The name of the entity where the relation starts"),
              to: z
                .string()
                .describe("The name of the entity where the relation ends"),
              relationType: z.string().describe("The type of the relation"),
            })
          )
          .describe("An array of relations to delete"),
      },
      async ({ relations }) => {
        await this.manager.deleteRelations(relations);
        return {
          content: [{ type: "text", text: "Relations deleted successfully" }],
        };
      }
    );

    // Search nodes tool
    this.mcpServer.tool(
      "search_nodes",
      "Search for nodes in the knowledge graph based on a query",
      {
        query: z
          .string()
          .describe(
            "The search query to match against entity names, types, and observation content"
          ),
        options: SearchNodesOptionsSchema
          .optional()
          .describe("Search options including scope and time range filtering"),
      },
      async ({ query, options }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await this.manager.searchNodes(query, options),
              null,
              2
            ),
          },
        ],
      })
    );

    // Search multi keywords tool
    this.mcpServer.tool(
      "search_multi_keywords",
      "Search for nodes using multiple keywords with configurable search options",
      {
        keywords: z
          .array(z.string())
          .describe("An array of keywords to search for"),
        options: MultiKeywordSearchOptionsSchema
          .optional()
          .describe("Search options including mode, scope and time range filtering"),
      },
      async ({ keywords, options }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await this.manager.searchMultiKeywords(keywords, options),
              null,
              2
            ),
          },
        ],
      })
    );

    // Open nodes tool
    this.mcpServer.tool(
      "open_nodes",
      "Open specific nodes in the knowledge graph by their names",
      {
        names: z.array(z.string()).describe("An array of entity names to retrieve"),
      },
      async ({ names }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await this.manager.openNodes(names),
              null,
              2
            ),
          },
        ],
      })
    );

    // Manual checkpoint tool
    this.mcpServer.tool(
      "manual_checkpoint",
      "Manually trigger DuckDB checkpoint to force WAL data to be written to disk",
      {},
      async () => {
        try {
          const result = await this.manager.checkpoint();
          return {
            content: [
              {
                type: "text",
                text: `Checkpoint completed successfully: ${result.message}`,
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: `Checkpoint failed: ${errorMessage}`,
              },
            ],
          };
        }
      }
    );
  }

  /**
   * Start the secondary server
   */
  async start(): Promise<void> {
    try {
      this.logger.info("Starting Secondary Server...");

      // Initialize proxy manager
      await this.manager.initialize();
      this.logger.info("Proxy manager initialized");

      // Connect MCP server to stdio transport
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);

      this.running = true;
      this.logger.info("Secondary Server started successfully", {
        mainServerSocket: this.config.ipc.socketPath
      });

    } catch (error) {
      this.logger.error("Failed to start Secondary Server", extractError(error));
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the secondary server
   */
  async stop(): Promise<void> {
    this.logger.info("Stopping Secondary Server...");
    this.running = false;

    try {
      // Close proxy manager
      await this.manager.close();
      this.logger.info("Proxy manager closed");

      this.logger.info("Secondary Server stopped successfully");
    } catch (error) {
      this.logger.error("Error stopping Secondary Server", extractError(error));
      throw error;
    }
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }
}