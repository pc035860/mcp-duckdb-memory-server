#!/bin/bash

# Example script to start MCP DuckDB Memory Server in main/secondary mode

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
MAIN_SERVER_PID_FILE="/tmp/mcp-main-server.pid"
MAIN_SERVER_LOG_FILE="/tmp/mcp-main-server.log"
SOCKET_PATH="$HOME/.local/share/duckdb-memory-server/main-server.sock"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if main server is running
is_main_server_running() {
    if [ -f "$MAIN_SERVER_PID_FILE" ]; then
        local pid=$(cat "$MAIN_SERVER_PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0
        else
            rm -f "$MAIN_SERVER_PID_FILE"
            return 1
        fi
    fi
    return 1
}

# Function to start main server
start_main_server() {
    if is_main_server_running; then
        print_warning "Main server is already running (PID: $(cat $MAIN_SERVER_PID_FILE))"
        return 0
    fi

    print_status "Starting main server..."
    
    # Remove old socket file if exists
    if [ -S "$SOCKET_PATH" ]; then
        rm -f "$SOCKET_PATH"
    fi

    # Start main server in background
    SERVER_MODE=main pnpm start > "$MAIN_SERVER_LOG_FILE" 2>&1 &
    local pid=$!
    
    # Save PID
    echo "$pid" > "$MAIN_SERVER_PID_FILE"
    
    # Wait for socket to be created
    local timeout=30
    local counter=0
    
    while [ ! -S "$SOCKET_PATH" ] && [ $counter -lt $timeout ]; do
        sleep 1
        counter=$((counter + 1))
        if ! ps -p "$pid" > /dev/null 2>&1; then
            print_error "Main server failed to start. Check log: $MAIN_SERVER_LOG_FILE"
            rm -f "$MAIN_SERVER_PID_FILE"
            return 1
        fi
    done
    
    if [ -S "$SOCKET_PATH" ]; then
        print_success "Main server started successfully (PID: $pid)"
        return 0
    else
        print_error "Main server startup timeout. Check log: $MAIN_SERVER_LOG_FILE"
        kill "$pid" 2>/dev/null
        rm -f "$MAIN_SERVER_PID_FILE"
        return 1
    fi
}

# Function to stop main server
stop_main_server() {
    if ! is_main_server_running; then
        print_warning "Main server is not running"
        return 0
    fi

    local pid=$(cat "$MAIN_SERVER_PID_FILE")
    print_status "Stopping main server (PID: $pid)..."
    
    kill "$pid"
    
    # Wait for process to exit
    local timeout=10
    local counter=0
    
    while ps -p "$pid" > /dev/null 2>&1 && [ $counter -lt $timeout ]; do
        sleep 1
        counter=$((counter + 1))
    done
    
    if ps -p "$pid" > /dev/null 2>&1; then
        print_warning "Force killing main server..."
        kill -9 "$pid"
    fi
    
    rm -f "$MAIN_SERVER_PID_FILE"
    rm -f "$SOCKET_PATH"
    print_success "Main server stopped"
}

# Function to start secondary server
start_secondary_server() {
    if ! is_main_server_running; then
        print_error "Main server is not running. Start it first with: $0 start-main"
        return 1
    fi
    
    print_status "Starting secondary server..."
    print_status "Press Ctrl+C to stop"
    SERVER_MODE=secondary pnpm start
}

# Function to show status
show_status() {
    echo "=== MCP DuckDB Memory Server Status ==="
    
    if is_main_server_running; then
        local pid=$(cat "$MAIN_SERVER_PID_FILE")
        print_success "Main server: Running (PID: $pid)"
        
        if [ -S "$SOCKET_PATH" ]; then
            print_success "Socket: Available ($SOCKET_PATH)"
        else
            print_error "Socket: Not found ($SOCKET_PATH)"
        fi
    else
        print_error "Main server: Not running"
    fi
    
    echo ""
    echo "Log file: $MAIN_SERVER_LOG_FILE"
    echo "Socket path: $SOCKET_PATH"
}

# Function to show logs
show_logs() {
    if [ -f "$MAIN_SERVER_LOG_FILE" ]; then
        echo "=== Main Server Logs ==="
        tail -f "$MAIN_SERVER_LOG_FILE"
    else
        print_error "Log file not found: $MAIN_SERVER_LOG_FILE"
    fi
}

# Main script
case "$1" in
    "start-main")
        start_main_server
        ;;
    "stop-main")
        stop_main_server
        ;;
    "restart-main")
        stop_main_server
        sleep 2
        start_main_server
        ;;
    "start-secondary")
        start_secondary_server
        ;;
    "status")
        show_status
        ;;
    "logs")
        show_logs
        ;;
    "start")
        # Start both main and secondary
        start_main_server
        if [ $? -eq 0 ]; then
            sleep 2
            start_secondary_server
        fi
        ;;
    "stop")
        stop_main_server
        ;;
    *)
        echo "Usage: $0 {start|stop|start-main|stop-main|restart-main|start-secondary|status|logs}"
        echo ""
        echo "Commands:"
        echo "  start           - Start main server and then secondary server"
        echo "  stop            - Stop main server"
        echo "  start-main      - Start only main server"
        echo "  stop-main       - Stop main server"
        echo "  restart-main    - Restart main server"
        echo "  start-secondary - Start secondary server (requires main server running)"
        echo "  status          - Show server status"
        echo "  logs            - Show main server logs"
        echo ""
        echo "Examples:"
        echo "  $0 start-main                # Start main server in background"
        echo "  $0 start-secondary           # Start secondary server (foreground)"
        echo "  $0 status                    # Check if servers are running"
        exit 1
        ;;
esac