#!/bin/bash
# DDIN TC Visit Reporting System - Local Development Startup Script
# Starts all backend services + frontend dev server

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "Missing .env. Copy .env.example to .env and configure the database and JWT secrets first."
  exit 1
fi

# Use one signing secret set for every local service. Per-service .env files are
# retained for standalone use, but exported values take precedence in this stack.
set -a
. "$PROJECT_DIR/.env"
set +a

echo "=== DDIN TC Visit Reporting System ==="
echo "Starting all services..."
echo ""

# Avoid terminating unrelated processes that happen to use application ports.
for port in 3000 3001 3002 3003 3004 5173; do
  if command -v lsof >/dev/null 2>&1 && lsof -ti:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop that service before starting this stack."
    exit 1
  fi
done

# Start backend services
echo "Starting AuthService on port 3001..."
(cd "$PROJECT_DIR/AuthService" && PORT=3001 node src/server.js) &

echo "Starting AgentsService on port 3002..."
(cd "$PROJECT_DIR/AgentsService" && PORT=3002 node src/server.js) &

echo "Starting VisitsService on port 3003..."
(cd "$PROJECT_DIR/VisitsService" && PORT=3003 node src/server.js) &

echo "Starting ReportsService on port 3004..."
(cd "$PROJECT_DIR/ReportsService" && PORT=3004 node src/server.js) &

sleep 2

echo "Starting ApiGateway on port 3000..."
(cd "$PROJECT_DIR/ApiGateway" && PORT=3000 node src/server.js) &

sleep 1

echo "Starting Frontend dev server on port 5173..."
cd "$PROJECT_DIR/frontend" && npx vite --host &

echo ""
echo "=== All services started ==="
echo ""
echo "  API Gateway:     http://localhost:3000"
echo "  Frontend:        http://localhost:5173"
echo ""
echo "  AuthService:     http://localhost:3001"
echo "  AgentsService:   http://localhost:3002"
echo "  VisitsService:   http://localhost:3003"
echo "  ReportsService:  http://localhost:3004"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

wait
