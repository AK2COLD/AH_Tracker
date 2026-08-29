-- Personal AH/Trade purchase log (imported from TSM csvBuys)
CREATE TABLE IF NOT EXISTS purchase_history (
    id               BIGSERIAL PRIMARY KEY,
    item_id          INTEGER       NOT NULL,
    quantity         INTEGER       NOT NULL,
    price_per_unit   INTEGER       NOT NULL,
    purchased_at     TIMESTAMPTZ   NOT NULL,
    source           VARCHAR(20)   NOT NULL DEFAULT 'Auction',
    character_name   VARCHAR(64),
    imported_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_purchase UNIQUE (item_id, character_name, purchased_at, price_per_unit, quantity)
);

CREATE INDEX IF NOT EXISTS idx_purchase_history_item_id    ON purchase_history (item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_history_purchased_at ON purchase_history (purchased_at DESC);
