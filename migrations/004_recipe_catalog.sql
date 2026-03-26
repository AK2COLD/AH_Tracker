CREATE TABLE IF NOT EXISTS recipe_catalog (
    recipe_id      INTEGER PRIMARY KEY,
    profession     TEXT NOT NULL,
    recipe_name    TEXT NOT NULL,
    output_item_id INTEGER,
    output_name    TEXT NOT NULL,
    output_qty     INTEGER NOT NULL DEFAULT 1,
    min_skill      INTEGER NOT NULL DEFAULT 0,
    materials      JSONB NOT NULL,
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS recipe_catalog_profession ON recipe_catalog(profession);
