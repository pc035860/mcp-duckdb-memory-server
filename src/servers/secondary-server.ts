import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProxyKnowledgeGraphManager } from "../managers/proxy-manager";
import { ServerConfig } from "../config/server-config";
import { Logger, ConsoleLogger } from "../logger";
import { extractError } from "../utils";
import { EntityObject, ObservationObject, RelationObject } from "../types";
import { SearchNodesOptionsSchema, MultiKeywordSearchOptionsSchema, buildSearchNodesOptionsSchema, buildMultiKeywordSearchOptionsSchema } from "../utils/time-validation-schemas";
import { SearchNodesOptions, MultiKeywordSearchOptions } from "../types";

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
   * Merge output options with config defaults
   */
  private mergeOutputOptions(options?: any): any {
    return {
      ...options,
      output: {
        ...(this.config.output || {}),
        ...(options?.output || {}),
      },
    };
  }

  /**
   * Setup MCP tools
   */
  private setupMCPTools(): void {
    const defaults = {
      compact: this.config.output?.compact ?? true,
      includeObservations: this.config.output?.includeObservations ?? false,
      maxEntities: this.config.output?.maxEntities ?? 20,
      maxObservationsPerEntity: this.config.output?.maxObservationsPerEntity ?? 3,
      snippetChars: this.config.output?.snippetChars ?? 280,
      includeRelations: (this.config.output?.includeRelations ?? 'subset') as 'none' | 'subset' | 'all',
      maxRelations: this.config.output?.maxRelations ?? 200,
      maxResponseChars: this.config.output?.maxResponseChars ?? 50000,
    } as const;
    const DynamicSearchNodesOptionsSchema = buildSearchNodesOptionsSchema(defaults);
    const DynamicMultiKeywordSearchOptionsSchema = buildMultiKeywordSearchOptionsSchema(defaults);
    // Create entities tool
    this.mcpServer.tool(
      "create_entities",
      "Create multiple new entities in the knowledge graph",
      {
        entities: z.array(EntityObject),
      },
      async ({ entities }) => {
        const payload = await this.manager.createEntities(entities);
        const text = JSON.stringify(payload);
        this.logger.debug("MCP response size (create_entities)", { chars: text.length });
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
    );

    // Create relations tool
    this.mcpServer.tool(
      "create_relations",
      "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
      {
        relations: z.array(RelationObject),
      },
      async ({ relations }) => {
        const payload = await this.manager.createRelations(relations);
        const text = JSON.stringify(payload);
        this.logger.debug("MCP response size (create_relations)", { chars: text.length });
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
    );

    // Add observations tool
    this.mcpServer.tool(
      "add_observations",
      "Add new observations to existing entities in the knowledge graph",
      {
        observations: z.array(ObservationObject),
      },
      async ({ observations }) => {
        const payload = await this.manager.addObservations(observations);
        const text = JSON.stringify(payload);
        this.logger.debug("MCP response size (add_observations)", { chars: text.length });
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
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
      "Search for nodes using advanced strategies: semantic, keyword, and hybrid. Semantic/hybrid uses AI embeddings (VSS) and is recommended for natural language queries, including Chinese. Keyword mode does exact/LIKE matching.",
      {
        query: z
          .string()
          .describe(
            "Query text matched against names, types, and observations. Prefer semantic/hybrid for natural language (multi-lingual, incl. Chinese). Use keyword for exact terms or operators."
          ),
        options: DynamicSearchNodesOptionsSchema
          .optional()
          .describe("Options: scope, time range, and strategy. Use searchMode: 'keyword' (text match), 'semantic' (VSS), 'hybrid' (recommended, multi-lingual incl. Chinese), or omit for auto."),
      },
      async ({ query, options }) => {
        const mergedOptions = this.mergeOutputOptions(options) as SearchNodesOptions;
        const payload = await this.manager.searchNodes(query, mergedOptions);
        const text = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        this.logger.debug("MCP response size (search_nodes)", { chars: text.length });
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
    );

    // Search multi keywords tool
    this.mcpServer.tool(
      "search_multi_keywords",
      "Search for nodes using multiple keywords with advanced search capabilities. Supports traditional keyword matching and semantic similarity search. Use this tool when you have multiple related search terms or concepts that should be combined.",
      {
        keywords: z
          .array(z.string())
          .describe("An array of keywords to search for. For semantic search, include conceptually related terms (e.g., ['authentication', 'login', 'security', 'user access']). For keyword search, use specific exact terms."),
        options: DynamicMultiKeywordSearchOptionsSchema
          .optional()
          .describe("Search options including combination mode (AND/OR), scope, time range filtering, and output formatting. The search uses the same advanced strategies as search_nodes, automatically selecting the best approach based on available services."),
      },
      async ({ keywords, options }) => {
        const mergedOptions = this.mergeOutputOptions(options) as MultiKeywordSearchOptions;
        const payload = await this.manager.searchMultiKeywords(keywords, mergedOptions);
        const text = JSON.stringify(payload);
        this.logger.debug("MCP response size (search_multi_keywords)", { chars: text.length });
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
    );

    // Open nodes tool
    this.mcpServer.tool(
      "open_nodes",
      "Retrieve complete details for specific entities by their exact names. Use this tool when you know the exact entity names and want full details including all observations and relations. This is different from search tools - use search_nodes for finding entities, then use open_nodes to get their complete information.",
      {
        names: z.array(z.string()).describe("An array of exact entity names to retrieve. Entity names are case-sensitive and must match exactly."),
        includeObservations: z.boolean().optional().describe("Whether to include complete observation content (default: true). Set to false for lightweight entity metadata only."),
      },
      async ({ names, includeObservations }) => {
        const payload = await this.manager.openNodes(names, { includeObservations });
        const text = JSON.stringify(payload);
        this.logger.debug("MCP response size (open_nodes)", { chars: text.length });
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }
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