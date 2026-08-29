#!/usr/bin/env bash
set -e

echo "=== AH Tracker Startup ==="

# Start PostgreSQL if not running
if ! pg_isready -q 2>/dev/null; then
  echo "Starting PostgreSQL..."
  sudo service postgresql start
else
  echo "PostgreSQL already running."
fi

# Load nvm
source "$HOME/.nvm/nvm.sh"

# Launch server
cd "$HOME/AH_Tracker"
echo "Starting AH Tracker server..."
exec npm start
