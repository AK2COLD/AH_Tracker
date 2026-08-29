# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Environment

- **Node.js** is managed via nvm. Always source it before running any node/npm command:
  ```bash
  source "$HOME/.nvm/nvm.sh" && npm run dev
  ```
- **PostgreSQL 16** runs inside WSL2 (not Windows-side). Start with `sudo service postgresql start`.
- **ES Modules** throughout — all files use `import/export`, never `require()`. The `"type": "module"` in package.json enforces this.
- WoW files live on the Windows filesystem, accessed via `/mnt/c/...` from WSL2.

## Commands

```bash
npm run dev          # Start with file-watching (restarts on changes)
npm start            # Production start
npm run import:tsm   # One-shot import of TSM AppData.lua market context
npm run import:recipes  # Sync recipe_catalog from CraftLib GitHub (run after adding professions)
node src/scripts/run_migrations.js  # Run pending DB migrations
```

No test suite exists. Verification is done by running the server and observing dashboard behavior.

## Architecture

The app is a personal WoW TBC Classic AH trading assistant with three data pipelines feeding one Express server:

### Data pipelines (all file-watching, poll every 10–30s for changes)

**1. `src/importer.js` ← `AHTrackerExport.lua` SavedVariables**
Reads the custom WoW addon's export file. Imports:
- `scan_log[]` — array of timestamped Auctionator price snapshots (one entry per AH visit, appended when the AH window closes). Each entry becomes distinct rows in `ah_snapshots` with `ON CONFLICT (item_id, scanned_at) DO NOTHING`.
- `character` — class, spec, race, faction, profession ranks, reputation standings → `profiles`
- `recipe_lines` — known recipes per profession (exported when tradeskill windows open) → `profiles.known_recipes`
- `production_log[]` — bag-diff detected crafts with mat quantities → `production_log`. Mat costs are priced server-side from `purchase_history` (90-day weighted avg), not by the addon.
- `gold` — current gold balance → `character_gold_snapshots`

**2. `src/tsm_importer.js` ← TradeSkillMaster `AppData.lua`**
Reads TSM AppHelper's AppData file (6 data blocks, base-36 encoded). Populates market context columns on the `items` table: `tsm_market_value`, `tsm_historical`, `tsm_num_auctions`, `region_sold_per_day`, `region_sale_pct`, `region_market_value`, `region_historical`. These are **never** used as price sources — only as demand/trend signals (sale rate, regional benchmarks).

**3. `src/tsm_sales_importer.js` ← TradeSkillMaster `TradeSkillMaster.lua`**
Parses TSM's `csvSales` and `csvBuys` personal transaction logs → `sales_history` and `purchase_history`. This is the source of truth for P&L. Also resolves unknown item names via the Blizzard item API (uses `src/auth.js` for OAuth2).

### Server

`src/api.js` — single Express app created by `createApp()`, mounted in `src/index.js`. All SQL lives in api.js route handlers (no ORM, raw `pg` queries). Serves `public/index.html` as static at `/`.

`src/db.js` — pg Pool + `bulkInsertSnapshots()` (chunked 1000-row inserts with `ON CONFLICT (item_id, scanned_at) DO NOTHING`) + `upsertItem()`.

`src/auth.js` — Blizzard OAuth2 client credentials token cache (used only by `tsm_sales_importer.js` for item name resolution).

### WoW Addon

`AHTrackerExport.lua` in the WoW AddOns folder.

**⚠️ Client history:** TBC Classic Anniversary migrated to the retail client engine in July 2026. The retail client removed the classic AH API (`GetAuctionItemInfo`, `GetAuctionItemLink`, `GetNumAuctionItems`, `AUCTION_ITEM_LIST_UPDATE`) in favour of the async `C_AuctionHouse` namespace. The addon detects which API is present at runtime:
```lua
local HAS_RETAIL_AH = C_AuctionHouse ~= nil
    and type(C_AuctionHouse.GetNumCommoditySearchResults) == "function"
```

**Price capture — retail (`C_AuctionHouse`):**
- `COMMODITY_SEARCH_RESULTS_UPDATED(itemID)` fires after every commodity search. Call `C_AuctionHouse.GetCommoditySearchResultInfo(itemID, i)` → `result.unitPrice` is already per-unit copper.
- `ITEM_SEARCH_RESULTS_ADDED(itemKey)` fires for non-commodity items. `itemKey` is a table `{itemID, itemLevel, ...}`. Call `C_AuctionHouse.GetItemSearchResultInfo(itemKey, i)` → `result.buyoutAmount / result.quantity` for per-unit price.

**Price capture — classic fallback (`AUCTION_ITEM_LIST_UPDATE`):**  
Used when `C_AuctionHouse` is absent. `GetAuctionItemInfo("list", i)` + `GetAuctionItemLink("list", i)`.

**Auctionator DB fallback:**  
If neither AH API captured data this session, `AppendScanLog()` reads `Auctionator.Database.db` (Auctionator's in-memory price cache) as a last resort.

**Other key behaviors:**
- `AUCTION_HOUSE_SHOW` → resets `sessionPrices`/`sessionNames` for the new AH visit.
- `AUCTION_HOUSE_CLOSED` → `C_Timer.After(0.5, AppendScanLog)` defers the write so the AH window closes instantly with no frame lag.
- `PLAYER_LOGIN` (1s delay) → `ExportCharacterData()`: class, spec (via `GetTalentTabInfo` pcall), professions, reputations, gold.
- `TRADE_SKILL_SHOW` → `ScanCurrentTradeskill()`: recipe enumeration with per-session count cache. All tradeskill calls wrapped in `pcall` since retail client may handle tradeskill API differently.
- `UNIT_SPELLCAST_SUCCEEDED` + `BAG_UPDATE_DELAYED` → craft detection via bag diff. `craftSpellFired` gate distinguishes crafts from loot/purchases.
- `PLAYER_MONEY` → keeps `AHTrackerExportData.gold` current.

WoW only writes SavedVariables to disk on logout or `/reload`. Price data captured during a session is only visible to the importer after the next logout/reload.

## Database Schema

All prices stored in **copper**. Frontend divides by 10000 for gold display.

| Table | Purpose |
|---|---|
| `items` | Master item reference. Populated lazily. Has TSM market context columns (migration 005). |
| `ah_snapshots` | One row per item per Auctionator scan. `time_left='AUCTIONATOR'` marks addon-sourced rows. Unique on `(item_id, scanned_at)`. |
| `ah_price_hourly` | Materialized view: min/avg/median unit price per item per hour. Refreshed after each import. 24h range queries now bypass this and hit `ah_snapshots` directly for per-scan granularity. |
| `watchlist` | FK to `items`. Items shown on the dashboard watchlist. |
| `profiles` | Single row (`user_id='default'`). Holds class/spec, professions (JSONB array), `profession_ranks` (JSONB object), `reputations` (JSONB), `known_recipes` (JSONB), `alchemy_spec`, `linked_characters`. |
| `recipe_catalog` | Populated by `npm run import:recipes` from CraftLib GitHub. `materials` is JSONB `[{name, qty}]`. Ingredient costs are looked up by item name at query time. |
| `sales_history` | From TSM csvSales. Unique on `(item_id, character_name, sold_at, price_per_unit, quantity)`. |
| `purchase_history` | From TSM csvBuys. Same unique constraint shape. Used to price crafting mats. |
| `production_log` | Craft log from addon bag-diff. Unique on `(character_name, crafted_at, item_id)`. `mats_snapshot` JSONB stores `[{item_id, item_name, qty, price_per}]`. |
| `character_gold_snapshots` | Append-only gold balance per character per login. |

## Key Conventions

**Recipe filtering (crafting widget):** The `/api/dashboard/crafting` endpoint uses a per-profession `knownByProfession` map. If the addon has synced recipes for a given profession, only `known_recipes` entries for that profession are shown. If not yet synced for a profession, it falls back to `min_skill` filtering. This prevents Alchemy from being hidden just because Cooking hasn't been synced.

**Alchemy proc yield:** `PROC_RATE = 0.15`, `PROC_EXTRA_AVG = 1.0`, `PROC_YIELD = 1.15`. Elixir Master procs on flasks + elixirs; Potion Master procs on potions. Transmutes and 'other' always get 1.0×. The constant appears in both `src/api.js` (server-side math) and `public/index.html` (frontend display text — must be kept in sync manually).

**Craft cost basis:** Mats are priced from `purchase_history` using a 90-day weighted average before the craft timestamp. No purchase record = gathered herb/item → cost 0. This happens in `insertProductionLog()` in `importer.js`, not in the addon.

**Vendor costs with rep discount:** `VENDOR_BASE_COSTS` and `REP_DISCOUNTS` in `api.js`. Best standing across `VENDOR_FACTIONS` determines discount. Imbued Vial and Crystal Vial are the main vendor reagents.

**Moving average for price signals:** Flask timing badges (MATS CHEAP / MATS PRICEY) compare current price vs 7-day moving average. MATS CHEAP = any mat >7% below MA; MATS PRICEY = any mat >10% above MA. Both can appear simultaneously on one card (different mats triggering each signal).

**P&L date grouping:** All daily P&L aggregation uses `America/New_York` timezone to match the user's local day boundary.

**APP_MODE:** Desktop launcher sets `APP_MODE=1`. The frontend sends `POST /api/heartbeat` every 8s; server shuts down after 45s without a heartbeat. Not active during `npm run dev`.

## Adding Migrations

Create `migrations/NNN_description.sql`, add it to the array in `src/scripts/run_migrations.js`, then run `node src/scripts/run_migrations.js`. Migrations are idempotent by convention (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

## Price Data Flow

```
User searches items at the AH:
  [Retail C_AuctionHouse path]
    COMMODITY_SEARCH_RESULTS_UPDATED(itemID)
      → C_AuctionHouse.GetCommoditySearchResultInfo(itemID, i) → result.unitPrice (per unit)
    ITEM_SEARCH_RESULTS_ADDED(itemKey)
      → C_AuctionHouse.GetItemSearchResultInfo(itemKey, i) → buyoutAmount/quantity
  [Classic fallback]
    AUCTION_ITEM_LIST_UPDATE
      → GetAuctionItemInfo("list", i) + GetAuctionItemLink("list", i)
  Both paths → RecordPrice() accumulates min-price per item in sessionPrices{}

  → AUCTION_HOUSE_CLOSED fires
  → C_Timer.After(0.5, AppendScanLog) [0.5s lag-free defer]
  → AppendScanLog() checks sessionPrices, falls back to Auctionator.Database.db if empty
  → appends {time, prices, names} to AHTrackerExportData.scan_log[] (max 50 entries)
  → WoW writes SavedVariables at logout/reload
  → importer.js detects file change (mtime polling every 10s)
  → parseScanLog() extracts each scan entry
  → bulkInsertSnapshots() with ON CONFLICT (item_id, scanned_at) DO NOTHING
  → REFRESH MATERIALIZED VIEW ah_price_hourly
  → /api/prices/:id?range=24h queries ah_snapshots directly (per-scan points)
  → /api/prices/:id?range=7d|30d queries ah_price_hourly (daily aggregates)
```
