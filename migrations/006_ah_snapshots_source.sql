-- Track the origin of each price snapshot (auctionator vs tsm)
ALTER TABLE ah_snapshots ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'auctionator';

-- Allow REFRESH MATERIALIZED VIEW CONCURRENTLY (non-blocking, safe during active queries)
-- Requires a unique index on the view's natural key; safe because GROUP BY already guarantees uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_ah_price_hourly_unique
    ON ah_price_hourly (item_id, hour);
