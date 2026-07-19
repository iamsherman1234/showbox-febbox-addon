#!/bin/bash

# Get the directory where this script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$DIR/.."

# Path to the virtual environment python
if [ -d "$ROOT_DIR/bypass/.venv" ]; then
    PYTHON_EXEC="$ROOT_DIR/bypass/.venv/bin/python"
elif [ -d "$ROOT_DIR/bypass/venv" ]; then
    PYTHON_EXEC="$ROOT_DIR/bypass/venv/bin/python"
else
    PYTHON_EXEC="python3"
fi
SERVER_SCRIPT="$ROOT_DIR/bypass/server.py"

# Try to extract port from api/.env BYPASS_URL
BYPASS_PORT=8000
if [ -f "$ROOT_DIR/api/.env" ]; then
    ENV_BYPASS_URL=$(grep "^BYPASS_URL=" "$ROOT_DIR/api/.env" | cut -d= -f2 | tr -d '"'\'' ')
    if [[ "$ENV_BYPASS_URL" =~ :([0-9]+) ]]; then
        BYPASS_PORT="${BASH_REMATCH[1]}"
    fi
fi

echo "Starting Cloudflare Bypass Server on port $BYPASS_PORT..."
echo "Python Executable: $PYTHON_EXEC"
echo "Server Script: $SERVER_SCRIPT"

# Check if already running on the same port or server.py general
if pgrep -f "server.py.*--port $BYPASS_PORT" > /dev/null; then
    echo "Server is already running on port $BYPASS_PORT."
else
    # Run in background
    nohup "$PYTHON_EXEC" "$SERVER_SCRIPT" --port "$BYPASS_PORT" > "$DIR/bypass_server.log" 2>&1 &
    echo "Server started in background. Logs are in bypass_server.log"
fi
