-- Character gold balance snapshots, exported by the addon on each login.
-- Used to track gold equity over time and cross-check P&L calculations.
CREATE TABLE IF NOT EXISTS character_gold_snapshots (
    id             BIGSERIAL    PRIMARY KEY,
    character_name TEXT         NOT NULL,
    gold_copper    BIGINT       NOT NULL,
    snapped_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gold_snap_char ON character_gold_snapshots (character_name, snapped_at DESC);
