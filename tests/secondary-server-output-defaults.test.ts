import { describe, it, expect, vi } from 'vitest';
import { SecondaryServer } from '../src/servers/secondary-server.js';
import { getServerConfig, ServerConfig } from '../src/config/server-config.js';
import { ConsoleLogger } from '../src/logger.js';
import { ProxyKnowledgeGraphManager } from '../src/managers/proxy-manager.js';

// Mock MCP server to capture tool registrations
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class McpServerMock {
    name: string;
    version: string;
    toolHandlers: Map<string, any> = new Map();
    constructor(opts: any) {
      this.name = opts?.name || '';
      this.version = opts?.version || '';
    }
    tool(name: string, _desc: string, _schema: any, handler: any) {
      this.toolHandlers.set(name, handler);
    }
    connect() {}
  }
  return { McpServer: McpServerMock };
});

vi.mock('../src/managers/proxy-manager.js', async (orig) => {
  const actual = await (orig as any)();
  return {
    ...actual,
    ProxyKnowledgeGraphManager: vi.fn().mockImplementation(() => ({
      initialize: vi.fn(),
      close: vi.fn(),
      searchNodes: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
      searchMultiKeywords: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    })),
  };
});

describe('SecondaryServer output defaults', () => {
  it('should merge config.output with options.output for search tools', async () => {
    const config: ServerConfig = {
      ...getServerConfig(),
      output: {
        compact: true,
        includeObservations: false,
        maxEntities: 5,
        maxObservationsPerEntity: 1,
        snippetChars: 10,
        includeRelations: 'subset',
        maxRelations: 3,
        maxResponseChars: 1000,
      },
    };

    const server = new SecondaryServer(config, new ConsoleLogger());
    // @ts-expect-error access private for test
    const manager: ProxyKnowledgeGraphManager = server['manager'];

    // Invoke the mcp tool handler directly
    // Access captured handler from mocked MCP server
    // @ts-expect-error access private for test
    const searchTool = server['mcpServer']['toolHandlers'].get('search_nodes');
    await searchTool({ query: 'test', options: { output: { maxEntities: 2 } } });

    expect((manager.searchNodes as any).mock.calls[0][1].output).toMatchObject({
      compact: true,
      includeObservations: false,
      maxEntities: 2, // caller override
      maxObservationsPerEntity: 1,
      snippetChars: 10,
      includeRelations: 'subset',
      maxRelations: 3,
      maxResponseChars: 1000,
    });
  });
});


