-- Migration 001: Add profiles table
-- Run: psql -h localhost -U postgres -d ah_tracker -f migrations/001_add_profiles.sql

CREATE TABLE IF NOT EXISTS profiles (
    id           BIGSERIAL    PRIMARY KEY,
    -- user_id is 'default' now; when auth is added each user gets a unique ID
    user_id      TEXT         NOT NULL DEFAULT 'default',
    display_name TEXT         NOT NULL DEFAULT 'My Profile',
    class        TEXT,
    spec         TEXT,
    faction      TEXT,
    race         TEXT,
    -- Array of profession names: ["Alchemy", "Herbalism", "Cooking"]
    professions  JSONB        NOT NULL DEFAULT '[]',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Insert a default profile so GET /api/profile always returns a row
INSERT INTO profiles (user_id, display_name)
VALUES ('default', 'My Profile')
ON CONFLICT (user_id) DO NOTHING;
