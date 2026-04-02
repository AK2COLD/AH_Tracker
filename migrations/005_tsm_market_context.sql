-- Migration 005: TSM market context columns on items table
-- These are populated by the TSM AppData importer from all 6 data blocks.
-- They are NEVER used as price sources — only as market intelligence signals.

ALTER TABLE items
    ADD COLUMN IF NOT EXISTS tsm_market_value    BIGINT,      -- SCAN_STAT: server-level market value (copper)
    ADD COLUMN IF NOT EXISTS tsm_historical      BIGINT,      -- HISTORICAL: server long-term price baseline (copper)
    ADD COLUMN IF NOT EXISTS tsm_num_auctions    INT,         -- DATA: current supply count on server
    ADD COLUMN IF NOT EXISTS region_market_value BIGINT,      -- REGION_STAT: regional fair value (copper)
    ADD COLUMN IF NOT EXISTS region_historical   BIGINT,      -- REGION_HISTORICAL: regional long-term baseline (copper)
    ADD COLUMN IF NOT EXISTS region_sold_per_day FLOAT,       -- REGION_SALE: avg items sold per day across region
    ADD COLUMN IF NOT EXISTS region_sale_pct     FLOAT,       -- REGION_SALE: % of listings that actually sell
    ADD COLUMN IF NOT EXISTS tsm_synced_at       TIMESTAMPTZ; -- when TSM AppData was last imported
