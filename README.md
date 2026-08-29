# AH Tracker — WoW TBC Classic Trading Assistant

A personal Node.js + PostgreSQL dashboard for tracking Auction House prices, crafting profitability, and P&L across a WoW TBC Classic character. Runs locally on WSL2 and pairs with a lightweight in-game addon.

---

## How It Works

Price data flows from in-game scans, not from background API polling:

1. The **AHTrackerExport** in-game addon captures Auctionator prices each time you close the AH window, appending a timestamped snapshot to its SavedVariables.
2. WoW writes SavedVariables to disk on logout or `/reload`.
3. The Node.js server watches for file changes and imports each scan as a distinct timestamped data point — so 5 AH visits in a night produce 5 separate price points.
4. TSM AppHelper and TSM's personal transaction log are imported separately for market context and P&L history.

---

## Prerequisites

- Node.js v18+ (via nvm)
- PostgreSQL 16 (WSL2 recommended)
- WoW TBC Classic with the [Auctionator](https://www.curseforge.com/wow/addons/auctionator) and [TradeSkillMaster](https://www.curseforge.com/wow/addons/tradeskillmaster) addons
- The **AHTrackerExport** addon installed in your WoW AddOns folder (in this repo)

---

## Setup

### 1. Install dependencies

```bash
source "$HOME/.nvm/nvm.sh"
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Key variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:yourpassword@localhost:5432/ah_tracker` |
| `WOW_SAVEDVARS_PATH` | Path to `AHTrackerExport.lua` SavedVariables file |
| `TSM_APP_DATA_PATH` | Path to TSM AppHelper's `AppData.lua` |
| `TSM_SAVEDVARS_PATH` | Path to `TradeSkillMaster.lua` (personal sales/buys log) |
| `TSM_REALM` | Your realm name, e.g. `Dreamscythe` |
| `BNET_CLIENT_ID` / `BNET_CLIENT_SECRET` | Blizzard API credentials (only needed for item name resolution) |

On WSL2, WoW paths look like:
```
/mnt/c/Program Files (x86)/World of Warcraft/_anniversary_/WTF/Account/ACCOUNTNAME/SavedVariables/AHTrackerExport.lua
```

### 3. Initialize the database

```bash
sudo service postgresql start
psql -U postgres -c "CREATE DATABASE ah_tracker;"
psql -U postgres -d ah_tracker -f schema.sql
source "$HOME/.nvm/nvm.sh" && node src/scripts/run_migrations.js
```

### 4. Populate the recipe catalog

```bash
source "$HOME/.nvm/nvm.sh" && npm run import:recipes
```

This pulls authoritative TBC recipe data from [CraftLib](https://github.com/kaldown/CraftLib). Re-run whenever you want to refresh recipe data.

### 5. Start the server

```bash
# Development (auto-restarts on changes)
source "$HOME/.nvm/nvm.sh" && npm run dev

# Or use the startup script (handles PostgreSQL + nvm automatically)
bash start_server.sh
```

Dashboard: **http://localhost:3000**

---

## In-Game Setup

Install the **AHTrackerExport** addon from `Interface/AddOns/AHTrackerExport/` in this repo.

Once installed:
- **Prices** — open the AH, search your items with Auctionator, close the AH. You'll see `[AHTrackerExport] Scan logged: N items`. Log out or `/reload` to flush to disk.
- **Recipes** — open your Alchemy (or other tradeskill) window once per session to sync your known recipes.
- **Crafting log** — crafts are detected automatically via bag-diff when the tradeskill window is open.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with file-watching (auto-restart) |
| `npm start` | Production start |
| `npm run import:tsm` | One-shot TSM AppData market context import |
| `npm run import:recipes` | Sync recipe catalog from CraftLib |
| `node src/scripts/run_migrations.js` | Apply pending DB migrations |

---

## Project Structure

```
AH_Tracker/
├── schema.sql                    ← Base DB schema (run once)
├── migrations/                   ← Incremental schema changes (001–011)
├── src/
│   ├── index.js                  ← Entry point: server + importers
│   ├── api.js                    ← All Express routes (~30 endpoints)
│   ├── db.js                     ← pg pool + bulk insert helpers
│   ├── auth.js                   ← Blizzard OAuth2 token cache
│   ├── importer.js               ← AHTrackerExport SavedVariables watcher
│   ├── tsm_importer.js           ← TSM AppData market context watcher
│   ├── tsm_sales_importer.js     ← TSM sales/buys history watcher
│   ├── data/
│   │   ├── consumables.js        ← TBC consumable definitions by spec
│   │   └── recipes.js            ← Supplemental recipe data
│   └── scripts/
│       ├── run_migrations.js     ← Migration runner
│       ├── sync_recipes.js       ← CraftLib recipe sync
│       └── import_tsm_once.js   ← One-shot TSM import
├── public/
│   └── index.html                ← Full dashboard UI (single file)
└── Interface/AddOns/AHTrackerExport/
    └── AHTrackerExport.lua       ← WoW addon
```

---

## Dashboard Features

- **Crafting Profits** — per-recipe margin, recommended daily quantity, CRAFT / SELL / HOLD signals
- **Flask Strategy** — Elixir Master vs Potion Master comparison with proc EV (1.15× multiplier)
- **Price Charts** — per-scan data points (exact Auctionator scan timestamps), 7d/30d daily trends
- **Deals** — items trading significantly below their 7-day moving average
- **Shopping List** — aggregated mat quantities for top daily recipes
- **Sales & P&L** — revenue, spend, net profit from TSM personal transaction log
- **Production** — cost-basis craft log, gold balance over time
