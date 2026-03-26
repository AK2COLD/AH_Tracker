/**
 * importer.js — WoW Auctionator SavedVariables importer
 *
 * Watches the AHTrackerExport.lua SavedVariables file that the in-game addon
 * writes after each Auctionator scan (or on login). When the file changes,
 * this module parses the Lua table and inserts the price data into the DB.
 *
 * The file is on the Windows filesystem (accessed via WSL2 /mnt/c/...).
 * We use stat-based polling instead of fs.watch because inotify events are
 * unreliable for Windows-side files in WSL2.
 */

import 'dotenv/config';
import fs from 'fs';
import { pool, bulkInsertSnapshots, upsertItem } from './db.js';

const SAVEDVARS_PATH = process.env.WOW_SAVEDVARS_PATH;

// How often to check whether the file has been updated (milliseconds)
const POLL_INTERVAL_MS = 10_000;  // every 10 seconds

// Track last-seen modification time to detect changes
let lastMtime = null;

/**
 * Starts watching the SavedVariables file for changes.
 * Calls importFile() immediately, then polls for changes every POLL_INTERVAL_MS.
 */
export function startImporter() {
    if (!SAVEDVARS_PATH) {
        console.warn('[importer] WOW_SAVEDVARS_PATH not set — importer disabled');
        return;
    }

    if (!fs.existsSync(SAVEDVARS_PATH)) {
        console.warn(`[importer] File not found: ${SAVEDVARS_PATH}`);
        console.warn('[importer] Enable the AHTrackerExport addon in WoW and log in to create it');
    }

    console.log(`[importer] Watching: ${SAVEDVARS_PATH}`);

    // Import immediately on startup in case the file already has data
    importIfChanged();

    // Then poll for changes
    setInterval(importIfChanged, POLL_INTERVAL_MS);
}

/**
 * Checks the file's modification time and runs importFile() if it changed.
 */
async function importIfChanged() {
    try {
        const stat = fs.statSync(SAVEDVARS_PATH);
        const mtime = stat.mtimeMs;

        if (mtime === lastMtime) return;  // No change since last check
        lastMtime = mtime;

        console.log(`[importer] File changed — importing…`);
        await importFile();

    } catch (err) {
        if (err.code === 'ENOENT') return;  // File doesn't exist yet, that's fine
        console.error('[importer] Error checking file:', err.message);
    }
}

/**
 * Reads and parses the SavedVariables file, then writes price data to the DB.
 */
async function importFile() {
    let raw;
    try {
        raw = fs.readFileSync(SAVEDVARS_PATH, 'utf8');
    } catch (err) {
        console.error('[importer] Could not read file:', err.message);
        return;
    }

    const data = parseSavedVars(raw);
    if (!data) {
        console.error('[importer] Could not parse SavedVariables file');
        return;
    }

    const { timestamp, realm, faction, prices, names, character, recipes } = data;

    console.log(`[importer] Parsed export from ${realm} ${faction} — ${Object.keys(prices).length} items`);

    // Convert Unix timestamp to ISO string for the DB
    const scannedAt = new Date(timestamp * 1000).toISOString();

    // --- 1. Upsert item names when we have them ---
    // We fire these in parallel (no transaction needed — ON CONFLICT DO NOTHING is safe)
    const upsertPromises = [];
    for (const [itemIdStr, name] of Object.entries(names)) {
        const itemId = parseInt(itemIdStr, 10);
        if (!isNaN(itemId) && name) {
            upsertPromises.push(upsertItem(itemId, name, null));
        }
    }
    if (upsertPromises.length > 0) {
        await Promise.all(upsertPromises);
        console.log(`[importer] Upserted ${upsertPromises.length} item names`);
    }

    // --- 2. Insert snapshots for all items with prices ---
    const rows = [];
    for (const [itemIdStr, price] of Object.entries(prices)) {
        const itemId = parseInt(itemIdStr, 10);
        if (!isNaN(itemId) && price > 0) {
            rows.push({
                item_id:    itemId,
                buyout:     price,
                quantity:   1,          // Auctionator stores min price, not per-listing data
                time_left:  'MEDIUM',   // Not available from price database
                scanned_at: scannedAt,
            });
        }
    }

    if (rows.length === 0) {
        console.warn('[importer] No valid price rows to insert');
        return;
    }

    await bulkInsertSnapshots(rows);
    console.log(`[importer] Inserted ${rows.length} snapshot rows`);

    // Refresh the materialized view so charts reflect the new data
    try {
        await pool.query('REFRESH MATERIALIZED VIEW ah_price_hourly');
        console.log('[importer] Materialized view refreshed');
    } catch (err) {
        console.warn('[importer] Could not refresh materialized view:', err.message);
    }

    // --- 4. Auto-sync character profile if the addon exported it ---
    if (character) {
        try {
            await upsertProfileFromCharacter(character);
        } catch (err) {
            console.warn('[importer] Could not sync character profile:', err.message);
        }
    }

    // --- 5. Auto-sync known recipes if the addon exported them ---
    if (recipes.length > 0) {
        try {
            await upsertKnownRecipes(recipes);
        } catch (err) {
            console.warn('[importer] Could not sync known recipes:', err.message);
        }
    }
}

/**
 * Parses the WoW SavedVariables Lua file written by the AHTrackerExport addon.
 *
 * Expected format:
 *   AHTrackerExportData = {
 *     ["timestamp"] = 1234567890,
 *     ["realm"] = "Dreamscythe",
 *     ["faction"] = "Horde",
 *     ["prices"] = {
 *       ["12345"] = 150000,
 *       ...
 *     },
 *     ["names"] = {
 *       ["12345"] = "Netherweave Cloth",
 *       ...
 *     },
 *     ["character"] = {
 *       ["class"]   = "Mage",
 *       ["spec"]    = "Arcane",
 *       ["race"]    = "Human",
 *       ["faction"] = "Alliance",
 *       ["profs"]   = "Alchemy:375|Cooking:290",
 *       ["reps"]    = "Cenarion Expedition:6|Lower City:7|...",
 *     },
 *   }
 *
 * Returns null if the file doesn't contain valid AHTrackerExportData.
 */
function parseSavedVars(raw) {
    // Make sure the file has our variable
    if (!raw.includes('AHTrackerExportData')) return null;

    const timestamp = extractNumber(raw, 'timestamp');
    const realm     = extractString(raw, 'realm');
    const faction   = extractString(raw, 'faction');

    if (!timestamp || !realm || !faction) return null;

    const prices    = extractTable(raw, 'prices');
    const names     = extractTable(raw, 'names');
    const character = parseCharacterBlock(raw);  // null if addon lacks character export
    const recipes   = parseRecipeLines(raw);      // [] if addon hasn't scanned tradeskills yet

    return { timestamp, realm, faction, prices, names, character, recipes };
}

/**
 * Parses the ["character"] sub-table, which uses string keys instead of numeric IDs.
 * Returns a structured object or null if the block is missing.
 */
function parseCharacterBlock(raw) {
    const charTable = extractStringTable(raw, 'character');
    if (!charTable.class) return null;

    // Parse "Alchemy:375|Cooking:290" → { professions: [...], profession_ranks: {...} }
    const professions      = [];
    const profession_ranks = {};
    if (charTable.profs) {
        for (const part of charTable.profs.split('|')) {
            const colon = part.lastIndexOf(':');
            if (colon > 0) {
                const name = part.slice(0, colon);
                const rank = parseInt(part.slice(colon + 1), 10);
                if (name && !isNaN(rank)) {
                    professions.push(name);
                    profession_ranks[name] = rank;
                }
            }
        }
    }

    // Parse "Cenarion Expedition:6|Lower City:7" → { "Cenarion Expedition": 6, ... }
    const reputations = {};
    if (charTable.reps) {
        for (const part of charTable.reps.split('|')) {
            const colon = part.lastIndexOf(':');
            if (colon > 0) {
                const name     = part.slice(0, colon);
                const standing = parseInt(part.slice(colon + 1), 10);
                if (name && !isNaN(standing)) {
                    reputations[name] = standing;
                }
            }
        }
    }

    return {
        class:   charTable.class,
        spec:    charTable.spec    || null,
        race:    charTable.race    || null,
        faction: charTable.faction || null,
        professions,
        profession_ranks,
        reputations,
    };
}

/**
 * Auto-upserts the player's profile from character data exported by the addon.
 * Keeps the DB profile in sync without requiring the user to set it manually.
 */
async function upsertProfileFromCharacter(char) {
    await pool.query(
        `INSERT INTO profiles
             (user_id, class, spec, faction, race, professions, profession_ranks, reputations, updated_at)
         VALUES ('default', $1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
             class            = EXCLUDED.class,
             spec             = EXCLUDED.spec,
             faction          = EXCLUDED.faction,
             race             = EXCLUDED.race,
             professions      = EXCLUDED.professions,
             profession_ranks = EXCLUDED.profession_ranks,
             reputations      = EXCLUDED.reputations,
             updated_at       = NOW()`,
        [
            char.class,
            char.spec,
            char.faction,
            char.race,
            JSON.stringify(char.professions),
            JSON.stringify(char.profession_ranks),
            JSON.stringify(char.reputations),
        ]
    );
    console.log(`[importer] Profile synced: ${char.class}/${char.spec} — professions: ${char.professions.join(', ') || 'none'}`);
}

/** Extracts ["key"] = 1234567890 from a Lua table string */
function extractNumber(raw, key) {
    const m = raw.match(new RegExp(`\\["${key}"\\]\\s*=\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : null;
}

/** Extracts ["key"] = "some string" from a Lua table string */
function extractString(raw, key) {
    const m = raw.match(new RegExp(`\\["${key}"\\]\\s*=\\s*"([^"]+)"`));
    return m ? m[1] : null;
}

/**
 * Extracts a nested table value by finding the section between
 * ["key"] = { ... } and returning all ["id"] = value pairs inside it.
 *
 * Returns an object { "id": value } where value is a number or string.
 */
function extractTable(raw, key) {
    // Find the start of the nested table
    const startMarker = `["${key}"] = {`;
    const startIdx = raw.indexOf(startMarker);
    if (startIdx === -1) return {};

    // Find the matching closing brace by counting braces
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx + startMarker.length - 1; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') {
            depth--;
            if (depth === 0) { endIdx = i; break; }
        }
    }
    if (endIdx === -1) return {};

    const section = raw.slice(startIdx + startMarker.length, endIdx);
    const result = {};

    // Match numeric values: ["12345"] = 150000
    const numRe = /\["(\d+)"\]\s*=\s*(\d+)/g;
    let m;
    while ((m = numRe.exec(section)) !== null) {
        result[m[1]] = parseInt(m[2], 10);
    }

    // Match string values: ["12345"] = "Item Name"
    const strRe = /\["(\d+)"\]\s*=\s*"([^"]+)"/g;
    while ((m = strRe.exec(section)) !== null) {
        result[m[1]] = m[2];
    }

    return result;
}

/**
 * Parses the recipe_lines string exported by the addon when the player opens
 * their tradeskill windows.
 *
 * Format: ";;"-separated lines, each line is:
 *   profession~recipeName~numMade~reagent1Name:qty|reagent2Name:qty
 *
 * Returns an array of recipe objects compatible with RECIPES in recipes.js.
 * Returns [] if the field is absent (player hasn't opened a tradeskill yet).
 */
function parseRecipeLines(raw) {
    const s = extractString(raw, 'recipe_lines');
    if (!s) return [];

    const recipes = [];
    for (const line of s.split(';;')) {
        if (!line) continue;
        const tildeIdx = line.indexOf('~');
        if (tildeIdx === -1) continue;
        const profession = line.slice(0, tildeIdx);
        const rest = line.slice(tildeIdx + 1);
        const parts = rest.split('~');
        if (parts.length < 3) continue;
        const [output_name, numMadeStr, reagentsStr] = parts;
        const materials = reagentsStr.split('|').flatMap(r => {
            const colon = r.lastIndexOf(':');
            if (colon <= 0) return [];
            const name = r.slice(0, colon);
            const qty  = parseInt(r.slice(colon + 1), 10);
            return name && qty > 0 ? [{ name, qty }] : [];
        });
        if (output_name && materials.length > 0) {
            recipes.push({
                profession,
                output_name,
                num_made: parseInt(numMadeStr, 10) || 1,
                materials,
            });
        }
    }
    return recipes;
}

/**
 * Upserts the player's known recipes (from tradeskill window scans) into
 * profiles.known_recipes. Only updates the known_recipes column so that
 * other profile fields are left untouched.
 */
async function upsertKnownRecipes(recipes) {
    await pool.query(
        `INSERT INTO profiles (user_id, known_recipes, updated_at)
         VALUES ('default', $1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
             known_recipes = EXCLUDED.known_recipes,
             updated_at    = NOW()`,
        [JSON.stringify(recipes)]
    );
    console.log(`[importer] Known recipes synced: ${recipes.length} recipes across ${new Set(recipes.map(r => r.profession)).size} professions`);
}

/**
 * Like extractTable, but matches string keys instead of numeric IDs.
 * Handles ["class"] = "Mage" and ["rank"] = 375 inside a nested table.
 */
function extractStringTable(raw, key) {
    const startMarker = `["${key}"] = {`;
    const startIdx = raw.indexOf(startMarker);
    if (startIdx === -1) return {};

    // Find the matching closing brace by counting braces
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx + startMarker.length - 1; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') {
            depth--;
            if (depth === 0) { endIdx = i; break; }
        }
    }
    if (endIdx === -1) return {};

    const section = raw.slice(startIdx + startMarker.length, endIdx);
    const result = {};

    // Match string-keyed string values: ["class"] = "Mage"
    const strRe = /\["([^"]+)"\]\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = strRe.exec(section)) !== null) {
        result[m[1]] = m[2];
    }

    // Match string-keyed numeric values: ["rank"] = 375
    const numRe = /\["([^"]+)"\]\s*=\s*(\d+)/g;
    while ((m = numRe.exec(section)) !== null) {
        if (!(m[1] in result)) result[m[1]] = parseInt(m[2], 10);
    }

    return result;
}
