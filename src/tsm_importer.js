/**
 * tsm_importer.js — TradeSkillMaster AppData.lua market context importer
 *
 * Watches TSM AppHelper's AppData.lua and extracts market intelligence signals
 * from all available data blocks. This data is written to market context columns
 * on the items table — it is NEVER used as a price source (Auctionator owns prices).
 *
 * Data blocks parsed and what each contributes:
 *   NON_COMMODITY_DATA      → tsm_num_auctions (supply count on your server)
 *   NON_COMMODITY_SCAN_STAT → tsm_market_value (server market value trend)
 *   NON_COMMODITY_HISTORICAL→ tsm_historical   (server long-term price baseline)
 *   REGION_SALE             → region_sold_per_day, region_sale_pct (demand velocity)
 *   REGION_STAT             → region_market_value (regional fair value benchmark)
 *   REGION_HISTORICAL       → region_historical  (regional long-term baseline)
 */

import 'dotenv/config';
import fs from 'fs';
import { pool } from './db.js';

const TSM_APP_DATA_PATH = process.env.TSM_APP_DATA_PATH;
const POLL_INTERVAL_MS  = 10_000;

let lastMtime = null;

export function startTsmImporter() {
    if (!TSM_APP_DATA_PATH) {
        console.warn('[tsm] TSM_APP_DATA_PATH not set — TSM importer disabled');
        return;
    }
    if (!fs.existsSync(TSM_APP_DATA_PATH)) {
        console.warn(`[tsm] AppData.lua not found at: ${TSM_APP_DATA_PATH}`);
    }
    console.log(`[tsm] Watching: ${TSM_APP_DATA_PATH}`);
    importIfChanged();
    setInterval(importIfChanged, POLL_INTERVAL_MS);
}

/**
 * Run a single import from AppData.lua and return.
 * Used by the standalone scheduled script (import_tsm_once.js).
 */
export { importTsmData };

async function importIfChanged() {
    try {
        const stat = fs.statSync(TSM_APP_DATA_PATH);
        const mtime = stat.mtimeMs;
        if (mtime === lastMtime) return;
        lastMtime = mtime;
        console.log('[tsm] AppData.lua changed — importing market context…');
        await importTsmData();
    } catch (err) {
        if (err.code === 'ENOENT') return;
        console.error('[tsm] Error checking file:', err.message);
    }
}

// ── Base-36 decoder ─────────────────────────────────────────────────────────
function b36(val) {
    if (val == null) return null;
    const n = parseInt(String(val), 36);
    return isNaN(n) || n <= 0 ? null : n;
}

// ── Generic block parser ─────────────────────────────────────────────────────
// Extracts all {val,val,...} entries from a named LoadData block.
// Returns Map<itemId, Object> keyed by the named fields.
function parseBlock(content, blockName) {
    const marker = `LoadData("${blockName}",`;
    const start  = content.indexOf(marker);
    if (start === -1) return new Map();

    const chunk = content.slice(start);

    const fieldsMatch = chunk.match(/fields=\{([^}]+)\}/);
    if (!fieldsMatch) return new Map();

    const fields   = [...fieldsMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const itemIdx  = fields.indexOf('itemString');
    if (itemIdx === -1) return new Map();

    const dataStart = chunk.indexOf('data={{');
    if (dataStart === -1) return new Map();

    const result  = new Map();
    const entryRe = /\{([\w,]+)\}/g;
    entryRe.lastIndex = dataStart + 5;

    let m;
    while ((m = entryRe.exec(chunk)) !== null) {
        const vals   = m[1].split(',');
        const itemId = parseInt(vals[itemIdx], 10);
        if (isNaN(itemId) || itemId <= 0) continue;

        const row = {};
        for (let i = 0; i < fields.length; i++) {
            if (i !== itemIdx) row[fields[i]] = vals[i];
        }
        // Last writer wins for duplicate itemIds (different auction listings)
        // — for market context we prefer the minimum-price entry for numAuctions
        // and average-style fields. We accumulate and reduce after.
        if (!result.has(itemId)) {
            result.set(itemId, []);
        }
        result.get(itemId).push(row);
    }

    return result;
}

// Reduce multiple entries per item to a single representative value.
// For price fields: take the minimum (most conservative).
// For count fields: take the sum.
// For rate fields: take the average.
function reduceEntries(entriesMap, field, mode = 'min') {
    const out = new Map();
    for (const [itemId, entries] of entriesMap) {
        const vals = entries
            .map(e => b36(e[field]))
            .filter(v => v != null);
        if (!vals.length) continue;
        let val;
        if (mode === 'min') val = Math.min(...vals);
        else if (mode === 'sum') val = vals.reduce((a, b) => a + b, 0);
        else val = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
        out.set(itemId, val);
    }
    return out;
}

async function importTsmData() {
    let content;
    try {
        content = fs.readFileSync(TSM_APP_DATA_PATH, 'utf8');
    } catch (err) {
        console.error('[tsm] Could not read AppData.lua:', err.message);
        return;
    }

    // Parse all blocks
    const dataBlock     = parseBlock(content, 'AUCTIONDB_NON_COMMODITY_DATA');
    const scanStatBlock = parseBlock(content, 'AUCTIONDB_NON_COMMODITY_SCAN_STAT');
    const histBlock     = parseBlock(content, 'AUCTIONDB_NON_COMMODITY_HISTORICAL');
    const regionSale    = parseBlock(content, 'AUCTIONDB_REGION_SALE');
    const regionStat    = parseBlock(content, 'AUCTIONDB_REGION_STAT');
    const regionHist    = parseBlock(content, 'AUCTIONDB_REGION_HISTORICAL');

    // Reduce to per-item values
    const minBuyout       = reduceEntries(dataBlock,     'minBuyout',        'min');
    const numAuctions     = reduceEntries(dataBlock,     'numAuctions',      'sum');
    const tsmMarketValue  = reduceEntries(scanStatBlock, 'marketValue',      'min');
    const tsmHistorical   = reduceEntries(histBlock,     'historical',       'min');
    const soldPerDay      = reduceEntries(regionSale,    'regionSoldPerDay', 'avg');
    const salePct         = reduceEntries(regionSale,    'regionSalePercent','avg');
    const regionMarketVal = reduceEntries(regionStat,    'regionMarketValue','min');
    const regionHistVal   = reduceEntries(regionHist,    'regionHistorical', 'min');

    // Collect all item IDs across all blocks
    const allIds = new Set([
        ...numAuctions.keys(),
        ...tsmMarketValue.keys(),
        ...tsmHistorical.keys(),
        ...soldPerDay.keys(),
        ...salePct.keys(),
        ...regionMarketVal.keys(),
        ...regionHistVal.keys(),
    ]);

    if (allIds.size === 0) {
        console.warn('[tsm] No items parsed — check TSM_APP_DATA_PATH and sync status');
        return;
    }

    // Upsert market context into items table in chunks of 500
    const ids = [...allIds];
    const CHUNK = 500;
    let updated = 0;

    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);

        // Build VALUES rows — only update columns we have data for
        const values = chunk.map(id => ({
            item_id:             id,
            tsm_num_auctions:    numAuctions.get(id)     ?? null,
            tsm_market_value:    tsmMarketValue.get(id)  ?? null,
            tsm_historical:      tsmHistorical.get(id)   ?? null,
            region_sold_per_day: soldPerDay.get(id)      != null ? soldPerDay.get(id) / 1000 : null,
            region_sale_pct:     salePct.get(id)         != null ? salePct.get(id)    / 1000 : null,
            region_market_value: regionMarketVal.get(id) ?? null,
            region_historical:   regionHistVal.get(id)   ?? null,
        }));

        // Batch upsert: insert into items if not exists, then update context columns
        for (const v of values) {
            await pool.query(
                `INSERT INTO items (item_id, tsm_num_auctions, tsm_market_value, tsm_historical,
                                    region_sold_per_day, region_sale_pct, region_market_value,
                                    region_historical, tsm_synced_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
                 ON CONFLICT (item_id) DO UPDATE SET
                     tsm_num_auctions    = COALESCE(EXCLUDED.tsm_num_auctions,    items.tsm_num_auctions),
                     tsm_market_value    = COALESCE(EXCLUDED.tsm_market_value,    items.tsm_market_value),
                     tsm_historical      = COALESCE(EXCLUDED.tsm_historical,      items.tsm_historical),
                     region_sold_per_day = COALESCE(EXCLUDED.region_sold_per_day, items.region_sold_per_day),
                     region_sale_pct     = COALESCE(EXCLUDED.region_sale_pct,     items.region_sale_pct),
                     region_market_value = COALESCE(EXCLUDED.region_market_value, items.region_market_value),
                     region_historical   = COALESCE(EXCLUDED.region_historical,   items.region_historical),
                     tsm_synced_at       = NOW()`,
                [v.item_id, v.tsm_num_auctions, v.tsm_market_value, v.tsm_historical,
                 v.region_sold_per_day, v.region_sale_pct, v.region_market_value, v.region_historical]
            );
        }
        updated += chunk.length;
    }

    console.log(`[tsm] Market context updated for ${updated} items`);

    // ── Write price snapshots for time-series charts ─────────────────────────
    // minBuyout gives a data point every 30 min even when the web app is closed.
    // source='tsm' distinguishes these from Auctionator scan rows.
    const snapIds    = [];
    const snapPrices = [];
    for (const [id, price] of minBuyout) {
        snapIds.push(id);
        snapPrices.push(price);
    }

    if (snapIds.length > 0) {
        await pool.query(
            `INSERT INTO ah_snapshots (item_id, buyout, quantity, time_left, source)
             SELECT unnest($1::int[]), unnest($2::bigint[]), 1, 'LONG', 'tsm'`,
            [snapIds, snapPrices]
        );
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY ah_price_hourly');
        console.log(`[tsm] Inserted ${snapIds.length} price snapshots, view refreshed`);
    }
}
