-- Link additional characters (e.g. bank alts) to the main profile.
-- Sales and purchase history are already tagged with character_name;
-- this array lets the dashboard aggregate across all linked characters.
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS linked_characters TEXT[] NOT NULL DEFAULT '{}';
