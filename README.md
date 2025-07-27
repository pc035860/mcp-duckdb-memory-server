# MCP DuckDB Memory Server

A Model Context Protocol (MCP) server that provides a persistent knowledge graph memory using DuckDB, now with **multi-client support** through a main/secondary server architecture.

## Architecture

The server now operates in two modes to enable true multi-client support:

### 🎯 Main Server
- **Purpose**: Owns the DuckDB database and processes all operations
- **Features**: 
  - Persistent DuckDB connection (no more instance-per-operation overhead)
  - Request queuing for proper serialization
  - Unix Domain Socket IPC server
  - Single source of truth for all data operations

### 🔄 Secondary Server  
- **Purpose**: Provides MCP interface and forwards requests to main server
- **Features**:
  - Standard MCP tools interface
  - Transparent request proxying via IPC
  - Automatic reconnection handling
  - Multiple secondary servers can connect to one main server

## Quick Start

### 1. Start Main Server

```bash
# Using environment variable
SERVER_MODE=main pnpm start

# Using command line flag
pnpm start -- --mode=main

# Using direct flag
pnpm start -- --main
```

The main server will:
- Initialize DuckDB with persistent connection
- Create Unix socket at `~/.local/share/duckdb-memory-server/main-server.sock`
- Wait for secondary servers to connect

### 2. Start Secondary Servers

```bash
# Using environment variable (default mode)
SERVER_MODE=secondary pnpm start

# Using command line flag
pnpm start -- --mode=secondary

# Using direct flag
pnpm start -- --secondary
```

Each secondary server will:
- Connect to the main server via Unix socket
- Provide standard MCP tools interface via stdio
- Forward all requests to main server for processing

### 3. Multiple Clients

You can now run multiple MCP clients simultaneously:

```bash
# Terminal 1: Start main server
SERVER_MODE=main pnpm start

# Terminal 2: First secondary server (e.g., for Claude Desktop)
SERVER_MODE=secondary pnpm start

# Terminal 3: Second secondary server (e.g., for another client)
SERVER_MODE=secondary pnpm start
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVER_MODE` | Server mode: `main` or `secondary` | `main` |
| `MEMORY_FILE_PATH` | Path to DuckDB database file | `~/.local/share/duckdb-memory-server/knowledge-graph.data` |
| `IPC_SOCKET_PATH` | Unix socket path for IPC | `~/.local/share/duckdb-memory-server/main-server.sock` |
| `QUEUE_MAX_SIZE` | Maximum request queue size | `100` |
| `QUEUE_TIMEOUT_MS` | Request timeout in milliseconds | `30000` |
| `DEBUG` | Enable debug logging | `false` |

### Command Line Options

- `--mode=main|secondary` - Set server mode
- `--main` - Shorthand for main mode
- `--secondary` - Shorthand for secondary mode

## Docker Deployment

### 🐳 Building Docker Image

```bash
# Build the image
docker build -t mcp-duckdb-memory-server .

# Or use Docker Compose
docker-compose build
```

### 🚀 Running with Docker

#### Main Server
```bash
# Run main server with persistent data
docker run -d \
  --name mcp-main-server \
  -v mcp-data:/app/data \
  -e SERVER_MODE=main \
  -e MEMORY_FILE_PATH=/app/data/knowledge-graph.data \
  -e IPC_SOCKET_PATH=/app/data/main-server.sock \
  mcp-duckdb-memory-server
```

#### Secondary Server  
```bash
# Run secondary server connected to main server
docker run -d \
  --name mcp-secondary-server \
  -v mcp-data:/app/data \
  -e SERVER_MODE=secondary \
  -e IPC_SOCKET_PATH=/app/data/main-server.sock \
  mcp-duckdb-memory-server
```

### 🔗 Docker Compose (Recommended)

Create `docker-compose.yml`:

```yaml
services:
  main-server:
    build: .
    environment:
      - SERVER_MODE=main
      - MEMORY_FILE_PATH=/app/data/knowledge-graph.data
      - IPC_SOCKET_PATH=/app/data/main-server.sock
      - DEBUG=false
    volumes:
      - mcp-data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "test", "-S", "/app/data/main-server.sock"]
      interval: 30s
      timeout: 10s
      retries: 3

  secondary-server-1:
    build: .
    environment:
      - SERVER_MODE=secondary
      - IPC_SOCKET_PATH=/app/data/main-server.sock
    volumes:
      - mcp-data:/app/data
    depends_on:
      main-server:
        condition: service_healthy
    restart: unless-stopped
    stdin_open: true
    tty: true

  secondary-server-2:
    build: .
    environment:
      - SERVER_MODE=secondary
      - IPC_SOCKET_PATH=/app/data/main-server.sock
    volumes:
      - mcp-data:/app/data
    depends_on:
      main-server:
        condition: service_healthy
    restart: unless-stopped
    stdin_open: true
    tty: true

volumes:
  mcp-data:
```

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

### 🔧 Docker Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_MODE` | `main` | Server operation mode |
| `MEMORY_FILE_PATH` | `/app/data/knowledge-graph.data` | DuckDB database file path |
| `IPC_SOCKET_PATH` | `/app/data/main-server.sock` | Unix socket for IPC |
| `QUEUE_MAX_SIZE` | `100` | Maximum request queue size |
| `QUEUE_TIMEOUT_MS` | `30000` | Request timeout in milliseconds |
| `DEBUG` | `false` | Enable debug logging |

## MCP Client Configuration

### 🎯 Claude Desktop

Create or update `~/.claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "duckdb-memory-server": {
      "command": "pnpm",
      "args": ["start"],
      "cwd": "/path/to/mcp-duckdb-memory-server",
      "env": {
        "SERVER_MODE": "secondary",
        "IPC_SOCKET_PATH": "/path/to/ipc-sock.sock"
      }
    }
  }
}
```

**Docker version:**
```json
{
  "mcpServers": {
    "duckdb-memory-server": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "mcp-data:/app/data",
        "-e", "SERVER_MODE=secondary",
        "-e", "IPC_SOCKET_PATH=/app/data/main-server.sock",
        "mcp-duckdb-memory-server"
      ]
    }
  }
}
```

### 🛠️ Other MCP Clients

For any MCP client that supports stdio transport:

```bash
# Ensure main server is running
SERVER_MODE=main pnpm start &

# Connect your client to secondary server
SERVER_MODE=secondary pnpm start
```

### 📦 Using with Smithery

Install via [Smithery](https://smithery.ai):

```bash
# Install globally
npx @smithery/cli install @izumisy/mcp-duckdb-memory-server

# Or add to your MCP configuration
```

Smithery configuration with custom path:
```json
{
  "memoryFilePath": "/path/to/your/custom/memory.data"
}
```

### 🔌 Direct Integration

For custom integrations, connect to the secondary server via stdio:

```javascript
import { spawn } from 'child_process';

const server = spawn('pnpm', ['start'], {
  cwd: '/path/to/mcp-duckdb-memory-server',
  env: { 
    ...process.env, 
    SERVER_MODE: 'secondary' 
  },
  stdio: ['pipe', 'pipe', 'pipe']
});

// Use server.stdin, server.stdout for MCP communication
```

## 📁 Example Files

The `examples/` directory contains ready-to-use configuration files:

- **`claude-desktop-config.json`** - Claude Desktop configuration using pnpm
- **`claude-desktop-config-docker.json`** - Claude Desktop configuration using Docker
- **`start-servers.sh`** - Bash script for managing main/secondary servers
- **`docker-compose.yml`** - Multi-server Docker deployment

### Using the Startup Script

```bash
# Make script executable
chmod +x examples/start-servers.sh

# Start main server in background
./examples/start-servers.sh start-main

# Start secondary server (in another terminal)
./examples/start-servers.sh start-secondary

# Check status
./examples/start-servers.sh status

# View logs
./examples/start-servers.sh logs

# Stop servers
./examples/start-servers.sh stop
```

## MCP Tools

All secondary servers provide the same MCP tools as before:

- `create_entities` - Create multiple new entities
- `create_relations` - Create relations between entities  
- `add_observations` - Add observations to entities
- `delete_entities` - Delete entities and their relations
- `delete_observations` - Delete specific observations
- `delete_relations` - Delete specific relations
- `search_nodes` - Search entities by query
- `search_multi_keywords` - Multi-keyword search with options
- `open_nodes` - Retrieve specific entities by name

## Utility Tools

### 🔀 Database Merge Tool

The `merge-duckdb` command-line tool allows you to merge two DuckDB knowledge graph databases:

```bash
# Install the package globally to use the merge tool
npm install -g @izumisy/mcp-duckdb-memory-server

# Merge two databases
merge-duckdb source1.db source2.db output.db

# Or use via npm scripts if installed locally
pnpm merge source1.db source2.db output.db
```

**Merge Rules:**
- **Entities**: Keeps the one with earlier `created_at` timestamp when names match
- **Observations**: Unions all unique observations per entity
- **Relations**: Keeps the one with earlier `created_at` when the triple (from, to, relationType) matches

**Example:**
```bash
# Merge knowledge from two different sessions
merge-duckdb ~/.local/share/duckdb-memory-server/session1.db \
             ~/.local/share/duckdb-memory-server/session2.db \
             ~/.local/share/duckdb-memory-server/merged.db

# Replace the main database with the merged one
mv ~/.local/share/duckdb-memory-server/merged.db \
   ~/.local/share/duckdb-memory-server/knowledge-graph.data
```

## Installation

```bash
pnpm install
pnpm build
```

## Development

```bash
# Build in development mode
pnpm build

# Run tests  
pnpm test

# Debug mode with configuration logging
DEBUG=1 SERVER_MODE=main pnpm start

# Development with MCP inspector
pnpm dev
```

## Architecture Benefits

✅ **True Multi-Client Support**: No more DuckDB file locking issues  
✅ **Better Performance**: Persistent connections, no instance recreation overhead  
✅ **Simplified Code**: Removed complex cleanup logic  
✅ **Scalable**: Easy to add more secondary servers  
✅ **Reliable**: Request queuing ensures data consistency  
✅ **Fault Tolerant**: Secondary servers auto-reconnect to main server  

## Migration from v1.1.2

The new architecture is **not backward compatible** but provides the same MCP interface:

1. **Stop all existing servers**
2. **Update to new version** 
3. **Start main server**: `SERVER_MODE=main pnpm start`
4. **Start secondary servers**: `SERVER_MODE=secondary pnpm start`
5. **Update your MCP client configs** to point to secondary servers

Your existing DuckDB data will be automatically migrated and preserved.

## Troubleshooting

### Main Server Won't Start
```bash
# Check if socket file exists and remove it
rm -f ~/.local/share/duckdb-memory-server/main-server.sock
SERVER_MODE=main pnpm start
```

### Secondary Server Can't Connect
```bash
# Ensure main server is running first
ps aux | grep "SERVER_MODE=main"

# Check socket file exists
ls -la ~/.local/share/duckdb-memory-server/main-server.sock
```

### Performance Issues
```bash
# Check queue status (main server logs)
DEBUG=1 SERVER_MODE=main pnpm start

# Monitor request processing
tail -f ~/.local/share/duckdb-memory-server/logs/main-server.log
```

## License

MIT License - see LICENSE file for details.