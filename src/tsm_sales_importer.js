/**
 * tsm_sales_importer.js — Parses TradeSkillMaster.lua for personal sales/buy history
 * and market context data.
 *
 * TSM stores two things we care about:
 *   1. csvSales / csvBuys — personal AH transaction log (source of truth for revenue tracking)
 *   2. AppHelper market context (region_sold_per_day, sale_pct, etc.) — handled by tsm_importer.js
 *
 * Sales rows: itemString, stackSize, quantity, price (copper/unit), otherPlayer, player, time, source
 * We import only Auction/Trade/COD records (skip Vendor self-sales).
 */

import fs from 'fs';
import { pool } from './db.js';
import { getAccessToken } from './auth.js';
import { log } from './logger.js';

const TSM_PATH = process.env.TSM_SAVEDVARS_PATH;
const TSM_REALM = process.env.TSM_REALM || 'Dreamscythe';
const POLL_MS   = 30_000;

let lastMtime = null;

export function startTsmSalesImporter() {
    if (!TSM_PATH) {
        log.warn('tsm-sales', 'TSM_SAVEDVARS_PATH not set — sales history disabled');
        return;
    }
    if (!fs.existsSync(TSM_PATH)) {
        log.warn('tsm-sales', 'TSM SavedVariables not found', { path: TSM_PATH });
        return;
    }
    log.info('tsm-sales', 'Watching TSM SavedVariables', { path: TSM_PATH });
    importIfChanged();
    setInterval(importIfChanged, POLL_MS);
}

async function importIfChanged() {
    try {
        const stat = fs.statSync(TSM_PATH);
        if (stat.mtimeMs === lastMtime) return;
        lastMtime = stat.mtimeMs;
        log.info('tsm-sales', 'File changed — importing sales history');
        await importSales();
    } catch (err) {
        if (err.code === 'ENOENT') return;
        log.error('tsm-sales', 'Error checking file', err);
    }
}

function extractCsv(raw, key) {
    // TSM Lua format: ["r@REALM@internalData@key"] = "value\nwith\nescapes"
    const needle = `["r@${TSM_REALM}@internalData@${key}"] = "`;
    const idx = raw.indexOf(needle);
    if (idx === -1) return null;
    const start = idx + needle.length;
    let pos = start;
    while (pos < raw.length) {
        if (raw[pos] === '"') break;
        if (raw[pos] === '\\') pos++;  // skip escaped char
        pos++;
    }
    if (pos >= raw.length) return null;
    return raw.slice(start, pos)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function parseCsvRows(csv) {
    if (!csv) return [];
    const lines = csv.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const header = lines[0].split(',');
    return lines.slice(1).map(line => {
        const parts = line.split(',');
        const obj = {};
        header.forEach((h, i) => { obj[h.trim()] = (parts[i] || '').trim(); });
        return obj;
    });
}

function parseItemId(itemString) {
    // "i:27667" or "i:27667:suffix" or "i:27667:-44"
    const m = itemString.match(/^i:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

// Extract all Name→item_id pairs from TSM's auctionSaleHints keys (and similar).
// Keys are encoded as ["Name\x01i:ItemID\x01qty\x01price"] throughout the file.
function extractItemNames(raw) {
    const map = {};
    const re = /\["([^\x01"]+)\x01i:(\d+)\x01/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        map[parseInt(m[2], 10)] = m[1];
    }
    return map; // { item_id: name }
}

async function upsertItemNames(nameMap) {
    if (!Object.keys(nameMap).length) return;
    for (const [itemId, name] of Object.entries(nameMap)) {
        await pool.query(
            `INSERT INTO items (item_id, name) VALUES ($1, $2)
             ON CONFLICT (item_id) DO UPDATE SET name = EXCLUDED.name
             WHERE items.name IS NULL`,
            [itemId, name]
        );
    }
}

// For item IDs that appear in sales/purchases but have no name, look them up
// via the Blizzard item API (rate-limited to one per 200ms to stay safe).
async function resolveUnknownItemNames() {
    const result = await pool.query(`
        SELECT DISTINCT item_id FROM (
            SELECT item_id FROM sales_history
            UNION
            SELECT item_id FROM purchase_history
        ) t
        WHERE item_id NOT IN (SELECT item_id FROM items WHERE name IS NOT NULL)
    `);
    if (!result.rows.length) return;

    let token;
    try { token = await getAccessToken(); } catch { return; }

    for (const { item_id } of result.rows) {
        try {
            const r = await fetch(
                `https://us.api.blizzard.com/data/wow/item/${item_id}?namespace=static-classic-us&locale=en_US`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!r.ok) continue;
            const data = await r.json();
            const name = data.name?.en_US ?? data.name;
            if (!name) continue;
            await pool.query(
                `INSERT INTO items (item_id, name) VALUES ($1, $2)
                 ON CONFLICT (item_id) DO UPDATE SET name = EXCLUDED.name
                 WHERE items.name IS NULL`,
                [item_id, name]
            );
            console.log(`[tsm-sales] Resolved name for item ${item_id}: ${name}`);
            await new Promise(r => setTimeout(r, 200));
        } catch { /* skip individual failures */ }
    }
}

async function importRows(rows, table, tsCol) {
    let inserted = 0, skipped = 0;
    for (const row of rows) {
        const itemId = parseItemId(row.itemString);
        const qty    = parseInt(row.quantity, 10);
        const price  = parseInt(row.price, 10);
        const ts     = parseInt(row.time, 10);
        const char   = row.player || null;
        const source = row.source || 'Auction';
        if (!itemId || !qty || !price || !ts) { skipped++; continue; }
        const at = new Date(ts * 1000).toISOString();
        try {
            await pool.query(
                `INSERT INTO ${table} (item_id, quantity, price_per_unit, ${tsCol}, source, character_name)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (item_id, character_name, ${tsCol}, price_per_unit, quantity) DO NOTHING`,
                [itemId, qty, price, at, source, char]
            );
            inserted++;
        } catch { skipped++; }
    }
    return { inserted, skipped };
}

async function importSales() {
    let raw;
    try { raw = fs.readFileSync(TSM_PATH, 'utf8'); }
    catch (err) { log.error('tsm-sales', 'Read failed', err); return; }

    // Backfill item names from TSM auction hint keys so sales/buys show real names
    const nameMap = extractItemNames(raw);
    await upsertItemNames(nameMap);

    const salesCsv = extractCsv(raw, 'csvSales');
    if (!salesCsv) { log.warn('tsm-sales', 'No csvSales found', { realm: TSM_REALM }); return; }

    const salesRows = parseCsvRows(salesCsv).filter(r =>
        r.source === 'Auction' || r.source === 'Trade' || r.source === 'COD'
    );
    const s = await importRows(salesRows, 'sales_history', 'sold_at');
    log.info('tsm-sales', 'Sales imported', { inserted: s.inserted, skipped: s.skipped });

    const buysCsv = extractCsv(raw, 'csvBuys');
    if (buysCsv) {
        const buyRows = parseCsvRows(buysCsv).filter(r =>
            r.source === 'Auction' || r.source === 'Trade' || r.source === 'COD'
        );
        const b = await importRows(buyRows, 'purchase_history', 'purchased_at');
        log.info('tsm-sales', 'Buys imported', { inserted: b.inserted, skipped: b.skipped });
    }

    await resolveUnknownItemNames();
}
