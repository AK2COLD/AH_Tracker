-- Production cost log: one row per craft batch detected by the WoW addon.
-- The addon snapshots bag contents before and after each craft to determine
-- what was produced and which mats were consumed, then prices them at TSM/Auctionator market value.
CREATE TABLE IF NOT EXISTS production_log (
    id               BIGSERIAL    PRIMARY KEY,
    character_name   TEXT         NOT NULL,
    item_id          INTEGER      NOT NULL,
    item_name        TEXT         NOT NULL,
    quantity         INTEGER      NOT NULL DEFAULT 1,
    crafted_at       TIMESTAMPTZ  NOT NULL,
    cost_per_unit    BIGINT       NOT NULL DEFAULT 0,  -- copper per output item
    total_cost       BIGINT       NOT NULL DEFAULT 0,  -- copper total for this batch
    mats_snapshot    JSONB,                             -- [{item_id,item_name,qty,price_per}]
    imported_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_production_log UNIQUE (character_name, crafted_at, item_id)
);

CREATE INDEX IF NOT EXISTS idx_production_log_char    ON production_log (character_name, crafted_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_log_item    ON production_log (item_id, crafted_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_log_crafted ON production_log (crafted_at DESC);
