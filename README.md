# AH Tracker — WoW TBC Classic Auction House Price Tracker

A Node.js service that polls the Blizzard Battle.net API every 60 seconds to
fetch all active auction house listings for a WoW Classic TBC realm, stores
them in a local PostgreSQL database, and serves a Robinhood-inspired web
dashboard for tracking item prices over time.

---

## Features

- Live auction data from the official Blizzard REST API (no in-game scanning)
- Persistent price history in PostgreSQL with hourly aggregates
- Web dashboard with watchlist, ticker cards (price + 24h % change), and charts
- Auto-refreshes every 60 seconds without a page reload

---

## Prerequisites

- Node.js v18 or higher
- PostgreSQL 16 installed and accessible via `psql`
- A Blizzard Developer account at https://develop.battle.net
- A Battle.net API client (Client ID + Secret)

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/ah-tracker.git
cd ah-tracker
npm install
```

### 2. Create your environment file

```bash
cp .env.example .env
```

Then open `.env` and fill in your values:

| Variable               | Description                                              |
|------------------------|----------------------------------------------------------|
| `BNET_CLIENT_ID`       | From your Battle.net API client                          |
| `BNET_CLIENT_SECRET`   | From your Battle.net API client                          |
| `BNET_REGION`          | `us` or `eu`                                             |
| `CONNECTED_REALM_ID`   | Numeric ID for your WoW Classic TBC connected realm      |
| `BNET_NAMESPACE`       | `dynamic-classic-us` or `dynamic-classic-eu`             |
| `DATABASE_URL`         | PostgreSQL connection string (see format below)          |
| `POLL_INTERVAL_SECONDS`| How often to poll (default: `60`)                        |
| `PORT`                 | Express server port (default: `3000`)                    |

**DATABASE_URL format:**
```
postgresql://USERNAME:PASSWORD@HOST:PORT/DATABASE_NAME
postgresql://postgres:yourpassword@localhost:5432/ah_tracker
```

### 3. Create the database

```bash
psql -U postgres -c "CREATE DATABASE ah_tracker;"
```

### 4. Run the schema to create tables and views

```bash
psql -U postgres -d ah_tracker -f schema.sql
```

### 5. Start the app

```bash
# Development mode (auto-restarts on file changes)
npm run dev

# Production mode
npm start
```

### 6. Open the dashboard

Visit: http://localhost:3000

---

## How to Find Your Connected Realm ID

1. Go to https://develop.battle.net/documentation/world-of-warcraft/game-data-apis
2. Use the "Connected Realm Index" endpoint in the API explorer, or:
3. Call the API directly:
   ```
   GET https://us.api.blizzard.com/data/wow/connected-realm/index
       ?namespace=dynamic-classic-us&locale=en_US&access_token=YOUR_TOKEN
   ```
4. Find your realm name in the results and note its numeric ID from the URL.

---

## Database Connection Notes

- Default PostgreSQL user: `postgres`
- Default host: `localhost`, port: `5432`
- If you set a password during PostgreSQL install, include it in the URL
- If you're on WSL2 and PostgreSQL is running inside WSL2, `localhost` works fine
- If PostgreSQL is installed on the Windows side, use the Windows host IP instead

---

## Git Workflow Reminder

```bash
git status                    # see what's changed
git add src/poller.js         # stage specific files
git add -p                    # stage changes interactively (recommended)
git commit -m "feat: describe your change"
git push origin main
```

Never commit `.env` — it's in `.gitignore` and contains your secrets.

---

## Project Structure

```
ah-tracker/
├── .env.example        ← copy to .env and fill in your values
├── .gitignore
├── package.json
├── schema.sql          ← run once to create DB tables and views
├── public/
│   └── index.html      ← dashboard UI (served at localhost:3000)
└── src/
    ├── index.js        ← entry point: starts server + scheduler
    ├── auth.js         ← Blizzard OAuth2 token manager
    ├── poller.js       ← fetches auctions and writes to DB
    ├── db.js           ← PostgreSQL pool and bulk insert helpers
    └── api.js          ← Express REST API + static file server
```
