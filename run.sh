#!/bin/bash

# Start Backend
echo "Starting Backend..."
cd backend
./venv/bin/python main.py &
BACKEND_PID=$!

# Start Frontend
echo "Starting Frontend..."
cd ../frontend
npm run dev &
FRONTEND_PID=$!

echo "Receipt Dashboard is running!"
echo "Backend: http://localhost:8000"
echo "Frontend: http://localhost:5173"

# Handle shutdown
trap "kill $BACKEND_PID $FRONTEND_PID; exit" INT TERM EXIT
wait
