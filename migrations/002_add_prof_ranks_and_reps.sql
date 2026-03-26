-- Migration 002: Add profession_ranks and reputations to profiles
-- Run: psql -h localhost -U postgres -d ah_tracker -f migrations/002_add_prof_ranks_and_reps.sql
--
-- profession_ranks: { "Alchemy": 375, "Cooking": 290, ... }
--   Populated automatically by the importer from addon character export data.
--   Used by the crafting widget to filter recipes the character can actually craft.
--
-- reputations: { "Cenarion Expedition": 6, "Lower City": 7, ... }
--   Standing IDs: 1=Hated 2=Hostile 3=Unfriendly 4=Neutral 5=Friendly 6=Honored 7=Revered 8=Exalted
--   Used to calculate vendor discounts on reagents like Imbued Vial and Crystal Vial.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS profession_ranks JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS reputations      JSONB NOT NULL DEFAULT '{}';
