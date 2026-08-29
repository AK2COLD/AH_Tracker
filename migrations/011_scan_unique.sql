-- 011_scan_unique.sql
-- Fresh start: clear API-polled bulk data and add unique constraint so
-- per-scan Auctionator imports can use ON CONFLICT DO NOTHING for safe re-import.
--
-- Old data from the Blizzard API poller (one row per auction listing per minute)
-- is low-signal noise. The new scan_log approach stores one row per item per
-- Auctionator scan session, with the exact scan timestamp, which is far higher quality.
TRUNCATE TABLE ah_snapshots RESTART IDENTITY;

REFRESH MATERIALIZED VIEW ah_price_hourly;

CREATE UNIQUE INDEX ah_snapshots_item_scan_unique
    ON ah_snapshots (item_id, scanned_at);
