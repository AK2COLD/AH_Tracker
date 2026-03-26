-- Migration 003: Add known_recipes to profiles
-- Run: psql -h localhost -U postgres -d ah_tracker -f migrations/003_add_known_recipes.sql
--
-- known_recipes: array of recipe objects exported from the in-game addon.
-- Each object: { profession, output_name, num_made, materials: [{name, qty}] }
-- Populated by the importer when the player opens their tradeskill windows in-game.
-- Replaces the hardcoded recipes.js data in the crafting profit widget.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS known_recipes JSONB NOT NULL DEFAULT '[]';
