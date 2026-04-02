/**
 * importer.js — AHTrackerExport addon SavedVariables importer
 *
 * Watches the AHTrackerExport.lua SavedVariables file for changes and imports
 * character profile data (class, spec, professions, reputations) and the
 * player's known recipes. Price data is now handled separately by
 * tsm_importer.js (TradeSkillMaster AppData.lua).
 *
 * The file is on the Windows filesystem (accessed via WSL2 /mnt/c/...).
 * We use stat-based polling instead of fs.watch because inotify events are
 * unreliable for Windows-side files in WSL2.
 */

import 'dotenv/config';
import fs from 'fs';
import { pool, bulkInsertSnapshots, upsertItem } from './db.js';

const SAVEDVARS_PATH = process.env.WOW_SAVEDVARS_PATH;
const POLL_INTERVAL_MS = 10_000;

let lastMtime = null;

/**
 * Starts watching the SavedVariables file for changes.
 * Calls importFile() immediately, then polls for changes every POLL_INTERVAL_MS.
 */
export function startImporter() {
    if (!SAVEDVARS_PATH) {
        console.warn('[importer] WOW_SAVEDVARS_PATH not set — character importer disabled');
        return;
    }

    if (!fs.existsSync(SAVEDVARS_PATH)) {
        console.warn(`[importer] File not found: ${SAVEDVARS_PATH}`);
        console.warn('[importer] Enable the AHTrackerExport addon in WoW and log in to create it');
    }

    console.log(`[importer] Watching: ${SAVEDVARS_PATH}`);
    importIfChanged();
    setInterval(importIfChanged, POLL_INTERVAL_MS);
}

async function importIfChanged() {
    try {
        const stat = fs.statSync(SAVEDVARS_PATH);
        const mtime = stat.mtimeMs;
        if (mtime === lastMtime) return;
        lastMtime = mtime;
        console.log('[importer] File changed — importing character data…');
        await importFile();
    } catch (err) {
        if (err.code === 'ENOENT') return;
        console.error('[importer] Error checking file:', err.message);
    }
}

async function importFile() {
    let raw;
    try {
        raw = fs.readFileSync(SAVEDVARS_PATH, 'utf8');
    } catch (err) {
        console.error('[importer] Could not read file:', err.message);
        return;
    }

    if (!raw.includes('AHTrackerExportData')) {
        console.error('[importer] Could not parse SavedVariables file');
        return;
    }

    const timestamp = extractNumber(raw, 'timestamp');
    const realm     = extractString(raw, 'realm');
    const faction   = extractString(raw, 'faction');
    console.log(`[importer] Parsing export from ${realm ?? '?'} ${faction ?? '?'}`);

    // ── 1. Auctionator prices (source of truth for current local AH prices) ──
    const prices = extractTable(raw, 'prices');
    const names  = extractTable(raw, 'names');

    if (timestamp && Object.keys(prices).length > 0) {
        const scannedAt = new Date(timestamp * 1000).toISOString();

        // Upsert item names
        const nameEntries = Object.entries(names);
        if (nameEntries.length > 0) {
            await Promise.all(nameEntries.map(([idStr, name]) => {
                const id = parseInt(idStr, 10);
                return isNaN(id) || !name ? null : upsertItem(id, name, null);
            }).filter(Boolean));
            console.log(`[importer] Upserted ${nameEntries.length} item names`);
        }

        // Insert price snapshots
        const rows = Object.entries(prices).flatMap(([idStr, price]) => {
            const id = parseInt(idStr, 10);
            return isNaN(id) || price <= 0 ? [] : [{ item_id: id, buyout: price, quantity: 1, time_left: 'MEDIUM', scanned_at: scannedAt }];
        });

        if (rows.length > 0) {
            await bulkInsertSnapshots(rows);
            console.log(`[importer] Inserted ${rows.length} Auctionator price snapshots`);
            try {
                await pool.query('REFRESH MATERIALIZED VIEW ah_price_hourly');
            } catch (err) {
                console.warn('[importer] Could not refresh materialized view:', err.message);
            }
        }
    }

    const character = parseCharacterBlock(raw);
    const recipes   = parseRecipeLines(raw);

    if (character) {
        try {
            await upsertProfileFromCharacter(character);
        } catch (err) {
            console.warn('[importer] Could not sync character profile:', err.message);
        }
    }

    if (recipes.length > 0) {
        try {
            await upsertKnownRecipes(recipes);
        } catch (err) {
            console.warn('[importer] Could not sync known recipes:', err.message);
        }
    }
}

/**
 * Parses the ["character"] sub-table from the SavedVariables file.
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

/**
 * Parses the recipe_lines string exported by the addon when the player opens
 * their tradeskill windows. Used to track which recipes the character has learned.
 *
 * Format: ";;"-separated lines, each: profession~recipeName~numMade~reagent1:qty|...
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
 * Upserts the player's known recipes into profiles.known_recipes.
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

/** Extracts ["key"] = 1234567890 from a Lua table string */
function extractNumber(raw, key) {
    const m = raw.match(new RegExp(`\\["${key}"\\]\\s*=\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Extracts a nested table: ["key"] = { ["id"] = value, ... }
 * Returns { id: value } where value is number or string.
 */
function extractTable(raw, key) {
    const startMarker = `["${key}"] = {`;
    const startIdx = raw.indexOf(startMarker);
    if (startIdx === -1) return {};

    let depth = 0, endIdx = -1;
    for (let i = startIdx + startMarker.length - 1; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx === -1) return {};

    const section = raw.slice(startIdx + startMarker.length, endIdx);
    const result  = {};

    let m;
    const numRe = /\["(\d+)"\]\s*=\s*(\d+)/g;
    while ((m = numRe.exec(section)) !== null) result[m[1]] = parseInt(m[2], 10);

    const strRe = /\["(\d+)"\]\s*=\s*"([^"]+)"/g;
    while ((m = strRe.exec(section)) !== null) result[m[1]] = m[2];

    return result;
}

/** Extracts ["key"] = "some string" from a Lua table string */
function extractString(raw, key) {
    const m = raw.match(new RegExp(`\\["${key}"\\]\\s*=\\s*"([^"]+)"`));
    return m ? m[1] : null;
}

/**
 * Extracts a nested table with string keys, e.g. ["character"] = { ["class"] = "Mage" }
 */
function extractStringTable(raw, key) {
    const startMarker = `["${key}"] = {`;
    const startIdx = raw.indexOf(startMarker);
    if (startIdx === -1) return {};

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

    const strRe = /\["([^"]+)"\]\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = strRe.exec(section)) !== null) {
        result[m[1]] = m[2];
    }

    const numRe = /\["([^"]+)"\]\s*=\s*(\d+)/g;
    while ((m = numRe.exec(section)) !== null) {
        if (!(m[1] in result)) result[m[1]] = parseInt(m[2], 10);
    }

    return result;
}
