#!/bin/bash
# Start both frontend and backend servers
# Frontend: synthetic-nature (React/Vite) on port 5173
# Backend: Express API on port 5001
# Usage: ./start-servers.sh

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."

echo "🚀 Starting ENZO servers..."
echo "   Root: $ROOT_DIR"

# Configuration
BACKEND_DIR="$ROOT_DIR"
FRONTEND_DIR="$ROOT_DIR/synthetic-nature"
BACKEND_PORT=5001
FRONTEND_PORT=5173

# Kill any existing processes on these ports
echo "🧹 Cleaning up existing processes..."
for port in $BACKEND_PORT $FRONTEND_PORT; do
  pid=$(lsof -ti :$port 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "  → Killing process on port $port (PID: $pid)"
    kill -9 $pid 2>/dev/null || true
  fi
done

# Start backend server
echo "🔧 Starting backend server on port $BACKEND_PORT..."
cd "$BACKEND_DIR"
npm start &
BACKEND_PID=$!

# Wait for backend to be ready
echo "⏳ Waiting for backend to be ready..."
for i in {1..15}; do
  if curl -s "http://localhost:$BACKEND_PORT" > /dev/null 2>&1; then
    echo "✅ Backend ready on http://localhost:$BACKEND_PORT"
    break
  fi
  if [ $i -eq 15 ]; then
    echo "⚠️ Backend may not be ready yet, continuing..."
  fi
  sleep 1
done

# Start frontend server
echo "🔧 Starting frontend server on port $FRONTEND_PORT..."
cd "$FRONTEND_DIR"
npm run dev &
FRONTEND_PID=$!

# Wait for frontend to be ready
echo "⏳ Waiting for frontend to be ready..."
for i in {1..15}; do
  if curl -s "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
    echo "✅ Frontend ready on http://localhost:$FRONTEND_PORT"
    break
  fi
  if [ $i -eq 15 ]; then
    echo "⚠️ Frontend may not be ready yet, continuing..."
  fi
  sleep 1
done

echo ""
echo "============================================"
echo "✅ Servers started successfully!"
echo ""
echo "  Frontend: http://localhost:$FRONTEND_PORT"
echo "  Backend:  http://localhost:$BACKEND_PORT"
echo ""
echo "Press Ctrl+C to stop both servers"
echo "============================================"

# Handle graceful shutdown
trap 'echo "Stopping servers..."; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0' SIGINT SIGTERM

# Keep script running and show logs
wait