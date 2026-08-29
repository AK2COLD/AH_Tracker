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
import { log } from './logger.js';

const SAVEDVARS_PATH = process.env.WOW_SAVEDVARS_PATH;
const POLL_INTERVAL_MS = 10_000;

let lastMtime = null;

/**
 * Starts watching the SavedVariables file for changes.
 * Calls importFile() immediately, then polls for changes every POLL_INTERVAL_MS.
 */
export function startImporter() {
    if (!SAVEDVARS_PATH) {
        log.warn('importer', 'WOW_SAVEDVARS_PATH not set — character importer disabled');
        return;
    }

    if (!fs.existsSync(SAVEDVARS_PATH)) {
        log.warn('importer', 'SavedVariables file not found', { path: SAVEDVARS_PATH });
    }

    log.info('importer', 'Watching SavedVariables', { path: SAVEDVARS_PATH });
    importIfChanged();
    setInterval(importIfChanged, POLL_INTERVAL_MS);
}

async function importIfChanged() {
    try {
        const stat = fs.statSync(SAVEDVARS_PATH);
        const mtime = stat.mtimeMs;
        if (mtime === lastMtime) return;
        lastMtime = mtime;
        log.info('importer', 'File changed — importing');
        await importFile();
    } catch (err) {
        if (err.code === 'ENOENT') return;
        log.error('importer', 'Error checking file', err);
    }
}

async function importFile() {
    let raw;
    try {
        raw = fs.readFileSync(SAVEDVARS_PATH, 'utf8');
    } catch (err) {
        log.error('importer', 'Could not read SavedVariables file', err);
        return;
    }

    if (!raw.includes('AHTrackerExportData')) {
        log.error('importer', 'SavedVariables missing AHTrackerExportData — addon not loaded?');
        return;
    }

    const realm   = extractString(raw, 'realm');
    const faction = extractString(raw, 'faction');
    log.info('importer', 'Parsing export', { realm: realm ?? '?', faction: faction ?? '?' });

    // ── 1. Price snapshots ────────────────────────────────────────────────────
    // New format: scan_log[] — one entry per AH visit, each with its own timestamp.
    // Old format (pre-reload): flat prices{} dict with a single file-level timestamp.
    // We try new format first; fall back to old so data flows before first /reload.
    const scanLog = parseScanLog(raw);
    let totalRows = 0;
    let scanEntries = 0;

    if (scanLog.length > 0) {
        for (const scan of scanLog) {
            const scannedAt = new Date(scan.time * 1000).toISOString();
            for (const [idStr, name] of Object.entries(scan.names)) {
                const id = parseInt(idStr, 10);
                if (!isNaN(id) && name) await upsertItem(id, name, null).catch(() => {});
            }
            const rows = Object.entries(scan.prices).flatMap(([idStr, price]) => {
                const id = parseInt(idStr, 10);
                return isNaN(id) || price <= 0 ? [] : [{
                    item_id: id, buyout: price, quantity: 1,
                    time_left: 'AUCTIONATOR', scanned_at: scannedAt,
                }];
            });
            if (rows.length > 0) {
                await bulkInsertSnapshots(rows);
                totalRows += rows.length;
                scanEntries++;
            }
        }
    } else {
        // Fallback: old single-dict format written before addon reload
        const timestamp = extractNumber(raw, 'timestamp');
        const prices    = extractTable(raw, 'prices');
        const names     = extractTable(raw, 'names');
        if (timestamp && Object.keys(prices).length > 0) {
            const scannedAt = new Date(timestamp * 1000).toISOString();
            const nameEntries = Object.entries(names);
            if (nameEntries.length > 0) {
                await Promise.all(nameEntries.map(([idStr, name]) => {
                    const id = parseInt(idStr, 10);
                    return isNaN(id) || !name ? null : upsertItem(id, name, null).catch(() => {});
                }).filter(Boolean));
            }
            const rows = Object.entries(prices).flatMap(([idStr, price]) => {
                const id = parseInt(idStr, 10);
                return isNaN(id) || price <= 0 ? [] : [{
                    item_id: id, buyout: price, quantity: 1,
                    time_left: 'AUCTIONATOR', scanned_at: scannedAt,
                }];
            });
            if (rows.length > 0) {
                await bulkInsertSnapshots(rows);
                totalRows += rows.length;
                scanEntries = 1;
            }
        }
    }

    if (totalRows > 0) {
        log.info('importer', 'Price rows inserted', { rows: totalRows, scans: scanEntries, format: scanEntries > 0 && scanLog.length > 0 ? 'scan_log' : 'legacy' });
        try {
            await pool.query('REFRESH MATERIALIZED VIEW ah_price_hourly');
        } catch (err) {
            log.error('importer', 'Could not refresh materialized view', err);
        }
    }

    const character    = parseCharacterBlock(raw);
    const recipes      = parseRecipeLines(raw);
    const gold         = extractNumber(raw, 'gold');
    const productionLog = parseProductionLog(raw);

    if (character) {
        try {
            await upsertProfileFromCharacter(character);
        } catch (err) {
            log.error('importer', 'Could not sync character profile', err);
        }
    }

    if (recipes.length > 0) {
        try {
            await upsertKnownRecipes(recipes);
        } catch (err) {
            log.error('importer', 'Could not sync known recipes', err);
        }
    }

    // Snapshot gold balance for P&L cross-check
    if (gold != null && character?.name) {
        try {
            await pool.query(
                `INSERT INTO character_gold_snapshots (character_name, gold_copper) VALUES ($1, $2)`,
                [character.name, gold]
            );
            log.info('importer', 'Gold snapshot', { character: character.name, gold_g: (gold / 10000).toFixed(1) });
        } catch (err) {
            log.error('importer', 'Could not insert gold snapshot', err);
        }
    }

    if (productionLog.length > 0) {
        try {
            await insertProductionLog(productionLog);
        } catch (err) {
            log.error('importer', 'Could not insert production log', err);
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
        name:    charTable.name    || null,
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
    const hasProfessions = char.professions && char.professions.length > 0;

    // Always update identity (class/spec/race/faction/name).
    // Only overwrite professions, ranks, and reputations when the logging-in
    // character actually has them — prevents a bank alt (0 professions) from
    // clobbering the crafter's Alchemy data on every login.
    await pool.query(
        `INSERT INTO profiles
             (user_id, class, spec, faction, race,
              professions, profession_ranks, reputations, updated_at)
         VALUES ('default', $1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
             class            = EXCLUDED.class,
             spec             = EXCLUDED.spec,
             faction          = EXCLUDED.faction,
             race             = EXCLUDED.race,
             professions      = CASE WHEN $8 THEN EXCLUDED.professions      ELSE profiles.professions      END,
             profession_ranks = CASE WHEN $8 THEN EXCLUDED.profession_ranks ELSE profiles.profession_ranks END,
             reputations      = CASE WHEN $8 THEN EXCLUDED.reputations      ELSE profiles.reputations      END,
             updated_at       = NOW()`,
        [
            char.class,
            char.spec,
            char.faction,
            char.race,
            JSON.stringify(char.professions),
            JSON.stringify(char.profession_ranks),
            JSON.stringify(char.reputations),
            hasProfessions,
        ]
    );
    log.info('importer', 'Profile synced', {
        character: char.name, class: char.class, spec: char.spec,
        professions: char.professions, professions_written: hasProfessions,
    });
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
    log.info('importer', 'Known recipes synced', { count: recipes.length, professions: [...new Set(recipes.map(r => r.profession))] });
}

/**
 * Parses the scan_log array from the SavedVariables file.
 * Each entry: { time: unixSeconds, prices: {itemId: copper}, names: {itemId: name} }
 * Returns [] if scan_log is absent (old addon version or first session).
 */
function parseScanLog(raw) {
    const startMarker = '["scan_log"] = {';
    const startIdx = raw.indexOf(startMarker);
    if (startIdx === -1) return [];

    let depth = 0, endIdx = -1;
    for (let i = startIdx + startMarker.length - 1; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx === -1) return [];

    const section = raw.slice(startIdx + startMarker.length, endIdx);
    const entries = [];

    let i = 0;
    while (i < section.length) {
        if (section[i] !== '{') { i++; continue; }
        let d = 0, entryEnd = -1;
        for (let j = i; j < section.length; j++) {
            if (section[j] === '{') d++;
            else if (section[j] === '}') { d--; if (d === 0) { entryEnd = j; break; } }
        }
        if (entryEnd === -1) break;

        const entryStr = section.slice(i + 1, entryEnd);
        const tsMatch = entryStr.match(/\["time"\]\s*=\s*(\d+)/);
        if (tsMatch) {
            const prices = extractTable(entryStr, 'prices');
            const names  = extractTable(entryStr, 'names');
            if (Object.keys(prices).length > 0) {
                entries.push({ time: parseInt(tsMatch[1], 10), prices, names });
            }
        }
        i = entryEnd + 1;
    }
    return entries;
}

/**
 * Parses the production_log array from the SavedVariables file.
 * Each entry was written by OnBagUpdateDelayed in the addon when a craft was detected.
 */
function parseProductionLog(raw) {
    const startMarker = '["production_log"] = {';
    const startIdx = raw.indexOf(startMarker);
    if (startIdx === -1) return [];

    // Find the end of the outer array
    let depth = 0, endIdx = -1;
    for (let i = startIdx + startMarker.length - 1; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx === -1) return [];

    const section = raw.slice(startIdx + startMarker.length, endIdx);
    const entries = [];

    // Each entry is a nested table: { ["time"]=N, ["character"]="X", ... ["mats"]={...} }
    // We find top-level entries by tracking brace depth
    let i = 0;
    while (i < section.length) {
        if (section[i] !== '{') { i++; continue; }
        // Found start of an entry table
        let depth2 = 0, entryEnd = -1;
        for (let j = i; j < section.length; j++) {
            if (section[j] === '{') depth2++;
            else if (section[j] === '}') { depth2--; if (depth2 === 0) { entryEnd = j; break; } }
        }
        if (entryEnd === -1) break;

        const entryStr = section.slice(i + 1, entryEnd);

        // Strip the mats sub-table from the search string so nested ["item_id"] /
        // ["item_name"] fields inside mats don't shadow the craft-level fields.
        const matsMarker = '["mats"] = {';
        const matsPos = entryStr.indexOf(matsMarker);
        let searchStr = entryStr;
        if (matsPos !== -1) {
            let md = 0, me = matsPos;
            for (let k = matsPos; k < entryStr.length; k++) {
                if (entryStr[k] === '{') md++;
                else if (entryStr[k] === '}') { md--; if (md === 0) { me = k; break; } }
            }
            searchStr = entryStr.slice(0, matsPos) + entryStr.slice(me + 1);
        }

        const getNum = (key) => {
            const m = searchStr.match(new RegExp(`\\["${key}"\\]\\s*=\\s*(\\d+)`));
            return m ? parseInt(m[1], 10) : null;
        };
        const getStr = (key) => {
            const m = searchStr.match(new RegExp(`\\["${key}"\\]\\s*=\\s*"([^"]*)"`));
            return m ? m[1] : null;
        };

        const ts          = getNum('time');
        const character   = getStr('character');
        const item_id     = getNum('item_id');
        const item_name   = getStr('item_name');
        const quantity    = getNum('quantity');
        const cost_per    = getNum('cost_per_unit');
        const total_cost  = getNum('total_cost');

        if (ts && character && item_id && item_name && quantity != null) {
            // Parse mats sub-array (use original entryStr, not the stripped searchStr)
            const matsStart = entryStr.indexOf('["mats"] = {');
            let matsSnapshot = [];
            if (matsStart !== -1) {
                let md = 0, me = -1;
                for (let k = matsStart + 11; k < entryStr.length; k++) {
                    if (entryStr[k] === '{') md++;
                    else if (entryStr[k] === '}') { md--; if (md === 0) { me = k; break; } }
                }
                if (me !== -1) {
                    const matsStr = entryStr.slice(matsStart + 12, me);
                    // Parse each mat entry
                    let mi = 0;
                    while (mi < matsStr.length) {
                        if (matsStr[mi] !== '{') { mi++; continue; }
                        let md2 = 0, me2 = -1;
                        for (let mj = mi; mj < matsStr.length; mj++) {
                            if (matsStr[mj] === '{') md2++;
                            else if (matsStr[mj] === '}') { md2--; if (md2 === 0) { me2 = mj; break; } }
                        }
                        if (me2 === -1) break;
                        const matStr = matsStr.slice(mi + 1, me2);
                        const mid   = matStr.match(/\["item_id"\]\s*=\s*(\d+)/)?.[1];
                        const mname = matStr.match(/\["item_name"\]\s*=\s*"([^"]*)"/)?.[1];
                        const mqty  = matStr.match(/\["qty"\]\s*=\s*(\d+)/)?.[1];
                        const mprc  = matStr.match(/\["price_per"\]\s*=\s*(\d+)/)?.[1];
                        if (mid && mname && mqty) {
                            matsSnapshot.push({ item_id: parseInt(mid), item_name: mname, qty: parseInt(mqty), price_per: parseInt(mprc || '0') });
                        }
                        mi = me2 + 1;
                    }
                }
            }

            entries.push({
                character_name: character,
                item_id,
                item_name,
                quantity,
                crafted_at:   new Date(ts * 1000).toISOString(),
                cost_per_unit: cost_per ?? 0,
                total_cost:    total_cost ?? 0,
                mats_snapshot: matsSnapshot,
            });
        }

        i = entryEnd + 1;
    }
    return entries;
}

async function insertProductionLog(entries) {
    let inserted = 0;
    for (const e of entries) {
        try {
            // Price each mat at the weighted-average actual purchase price paid,
            // looking back up to 90 days before the craft time.
            // No purchase record = gathered herb/item → cost 0.
            let totalCost = 0;
            const pricedMats = await Promise.all(e.mats_snapshot.map(async (mat) => {
                const r = await pool.query(
                    `SELECT ROUND(
                         SUM(price_per_unit::numeric * quantity) / NULLIF(SUM(quantity), 0)
                     )::BIGINT AS avg_price
                     FROM purchase_history
                     WHERE item_id = $1
                       AND purchased_at <= $2
                       AND purchased_at >= $2::timestamptz - INTERVAL '90 days'`,
                    [mat.item_id, e.crafted_at]
                );
                const price = Number(r.rows[0]?.avg_price ?? 0);
                totalCost += price * mat.qty;
                return { ...mat, price_per: price };
            }));

            const costPerUnit = e.quantity > 0 ? Math.round(totalCost / e.quantity) : 0;

            const result = await pool.query(
                `INSERT INTO production_log
                     (character_name, item_id, item_name, quantity, crafted_at,
                      cost_per_unit, total_cost, mats_snapshot)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (character_name, crafted_at, item_id) DO UPDATE SET
                     cost_per_unit = EXCLUDED.cost_per_unit,
                     total_cost    = EXCLUDED.total_cost,
                     mats_snapshot = EXCLUDED.mats_snapshot`,
                [e.character_name, e.item_id, e.item_name, e.quantity,
                 e.crafted_at, costPerUnit, totalCost,
                 JSON.stringify(pricedMats)]
            );
            if (result.rowCount > 0) inserted++;
        } catch (err) {
            log.error('importer', 'production_log insert error', err);
        }
    }
    if (inserted > 0) log.info('importer', 'Production log imported', { entries: inserted });
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
