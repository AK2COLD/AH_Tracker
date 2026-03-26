-- AH Tracker Database Schema
-- Run this once to initialize the database:
--   psql -U postgres -d ah_tracker -f schema.sql

-- ============================================================
-- items
-- Master reference table for WoW items we've seen or followed.
-- Populated lazily as the poller discovers new item_ids.
-- ============================================================
CREATE TABLE IF NOT EXISTS items (
    item_id   INTEGER PRIMARY KEY,
    name      TEXT,
    quality   SMALLINT   -- 0=Poor, 1=Common, 2=Uncommon, 3=Rare, 4=Epic, 5=Legendary
);

-- ============================================================
-- ah_snapshots
-- One row per auction listing, per poll cycle.
-- Buyout is stored raw in copper (as returned by the API).
-- We never convert to gold here — that happens in the frontend.
-- No FK to items intentionally: we don't want inserts to fail
-- just because an item hasn't been named yet.
-- ============================================================
CREATE TABLE IF NOT EXISTS ah_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    item_id     INTEGER       NOT NULL,
    buyout      BIGINT        NOT NULL,  -- price in copper
    quantity    INTEGER       NOT NULL,
    time_left   TEXT          NOT NULL,  -- SHORT, MEDIUM, LONG, VERY_LONG
    scanned_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Index for fast per-item time-series lookups (used by the chart API)
CREATE INDEX IF NOT EXISTS idx_ah_snapshots_item_time
    ON ah_snapshots (item_id, scanned_at DESC);

-- ============================================================
-- watchlist
-- Items the user has chosen to follow on the dashboard.
-- item_name is stored directly so the watchlist still shows
-- names even if the item hasn't been added to the items table.
-- ============================================================
CREATE TABLE IF NOT EXISTS watchlist (
    id          BIGSERIAL PRIMARY KEY,
    item_id     INTEGER       NOT NULL REFERENCES items(item_id),
    item_name   TEXT          NOT NULL,
    added_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE(item_id)
);

-- ============================================================
-- ah_price_hourly (materialized view)
-- Aggregates min, avg, and median unit price per item per hour.
-- Unit price = buyout / quantity (price per single item).
-- Refresh with: REFRESH MATERIALIZED VIEW ah_price_hourly;
-- Much faster than computing this on every chart request.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS ah_price_hourly AS
SELECT
    item_id,
    DATE_TRUNC('hour', scanned_at)          AS hour,
    MIN(buyout / quantity)                  AS min_unit_price,
    AVG(buyout / quantity)::BIGINT          AS avg_unit_price,
    -- Median via percentile_cont — more robust than avg for skewed AH prices
    PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY buyout / quantity
    )::BIGINT                               AS median_unit_price,
    SUM(quantity)                           AS total_supply
FROM ah_snapshots
GROUP BY item_id, DATE_TRUNC('hour', scanned_at)
WITH DATA;

-- Index the materialized view so chart queries stay fast
CREATE INDEX IF NOT EXISTS idx_ah_price_hourly_item_hour
    ON ah_price_hourly (item_id, hour DESC);
