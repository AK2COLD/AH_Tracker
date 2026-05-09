/**
 * api.js — Express REST API + static file server
 *
 * This module creates and configures the Express app. It exposes JSON
 * endpoints for the dashboard to consume, and serves the public/ folder
 * so the HTML dashboard loads at the root URL.
 *
 * Responsibility boundary: this file handles HTTP. All data access goes
 * through db.js — no raw SQL should live in route handlers.
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './db.js';
import { getConsumablesForSpec, getSpecRole } from './data/consumables.js';

// ES Modules don't have __dirname — this is the standard workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Alchemy Volume Strategy helpers ─────────────────────────────────────────
const PROC_RATE      = 0.10;
const PROC_EXTRA_AVG = 3.5;  // avg of 2–5 extra items
const PROC_YIELD     = 1 + PROC_RATE * PROC_EXTRA_AVG; // 1.35

function classifyAlchemyType(profession, recipeName, outputName) {
    if (profession !== 'Alchemy') return null;
    const rn = recipeName || '';
    const on = outputName  || '';
    if (rn.startsWith('Transmute:')) return 'transmute';
    if (on.includes('Flask of') || on === 'Flask of Chromatic Wonder') return 'flask';
    if (on.startsWith('Elixir') || on.includes('Elixir')) return 'elixir';
    if (on.includes('Potion') || on.includes('Cauldron')) return 'potion';
    return 'other'; // Alchemist stones, etc.
}

// Returns the effective yield multiplier given spec + recipe type.
// Elixir Master procs on flasks + elixirs; Potion Master procs on potions.
function alchemyProcYield(alchemyType, alchemySpec) {
    if (!alchemyType || alchemyType === 'transmute' || alchemyType === 'other') return 1.0;
    if (alchemySpec === 'Elixir Master'  && (alchemyType === 'flask' || alchemyType === 'elixir')) return PROC_YIELD;
    if (alchemySpec === 'Potion Master'  && alchemyType === 'potion') return PROC_YIELD;
    return 1.0;
}

// ── App-mode auto-shutdown (activated by APP_MODE=1 env var) ────────────────
// Desktop launcher sets APP_MODE=1. The frontend sends POST /api/heartbeat
// every 8 seconds. If 45 seconds pass without a ping, we exit cleanly.
// Normal `npm run dev` runs without APP_MODE, so this never fires in dev.
let lastHeartbeat    = null;
let watcherInstalled = false;

function installShutdownWatcher() {
    if (watcherInstalled || process.env.APP_MODE !== '1') return;
    watcherInstalled = true;
    setInterval(() => {
        if (lastHeartbeat && Date.now() - lastHeartbeat > 45_000) {
            console.log('[server] App window closed — shutting down (APP_MODE).');
            process.exit(0);
        }
    }, 10_000);
}

export function createApp() {
    const app = express();
    app.set('etag', false);
    app.use(express.json());

    // Serve everything in public/ as static files.
    // index.html will be served automatically at GET /
    app.use(express.static(join(__dirname, '..', 'public')));

    // Disable caching for all API responses — prices change frequently
    app.use('/api', (_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    // ----------------------------------------------------------------
    // POST /api/heartbeat — frontend pings every 8s to keep server alive
    // ----------------------------------------------------------------
    app.post('/api/heartbeat', (_req, res) => {
        lastHeartbeat = Date.now();
        installShutdownWatcher();
        res.json({ ok: true });
    });

    // ----------------------------------------------------------------
    // GET /api/watchlist — return all items the user is following
    // ----------------------------------------------------------------
    app.get('/api/watchlist', async (_req, res) => {
        try {
            const result = await pool.query(
                `SELECT item_id, item_name, added_at
                 FROM watchlist
                 ORDER BY added_at DESC`
            );
            res.json(result.rows);
        } catch (err) {
            console.error('[api] GET /api/watchlist failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // POST /api/watchlist — add an item to the watchlist
    // Body: { item_id: number, item_name: string }
    // ----------------------------------------------------------------
    app.post('/api/watchlist', async (req, res) => {
        const { item_id, item_name } = req.body;

        if (!item_id || !item_name) {
            return res.status(400).json({ error: 'item_id and item_name are required' });
        }

        try {
            // Ensure the item exists in the items table before adding to watchlist
            // (watchlist.item_id has a FK to items.item_id)
            await pool.query(
                `INSERT INTO items (item_id, name) VALUES ($1, $2) ON CONFLICT (item_id) DO NOTHING`,
                [item_id, item_name]
            );

            const result = await pool.query(
                `INSERT INTO watchlist (item_id, item_name)
                 VALUES ($1, $2)
                 ON CONFLICT (item_id) DO NOTHING
                 RETURNING *`,
                [item_id, item_name]
            );

            if (result.rows.length === 0) {
                // Item was already in watchlist — still a success
                return res.status(200).json({ message: 'Already in watchlist' });
            }

            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error('[api] POST /api/watchlist failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // DELETE /api/watchlist/:item_id — unfollow an item
    // ----------------------------------------------------------------
    app.delete('/api/watchlist/:item_id', async (req, res) => {
        const itemId = parseInt(req.params.item_id, 10);

        if (isNaN(itemId)) {
            return res.status(400).json({ error: 'Invalid item_id' });
        }

        try {
            const result = await pool.query(
                `DELETE FROM watchlist WHERE item_id = $1 RETURNING item_id`,
                [itemId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Item not in watchlist' });
            }

            res.json({ message: 'Removed from watchlist', item_id: itemId });
        } catch (err) {
            console.error('[api] DELETE /api/watchlist failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/items/search?q=name — search items by name
    // Used by the dashboard search box to find items to follow
    // ----------------------------------------------------------------
    app.get('/api/items/search', async (req, res) => {
        const q = req.query.q?.trim();

        if (!q || q.length < 2) {
            return res.json([]);
        }

        try {
            // ILIKE = case-insensitive LIKE. The % wildcards match anywhere in the name.
            const result = await pool.query(
                `SELECT item_id, name, quality
                 FROM items
                 WHERE name ILIKE $1
                 ORDER BY name
                 LIMIT 20`,
                [`%${q}%`]
            );
            res.json(result.rows);
        } catch (err) {
            console.error('[api] GET /api/items/search failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/prices/:item_id?range=24h|7d|30d
    // 24h → hourly buckets. 7d / 30d → daily aggregates.
    // All prices in copper.
    // ----------------------------------------------------------------
    app.get('/api/prices/:item_id', async (req, res) => {
        const itemId = parseInt(req.params.item_id, 10);
        if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item_id' });

        const range = req.query.range || '24h';

        try {
            let result;
            if (range === '7d' || range === '28d' || range === '30d') {
                const interval = range === '7d' ? '7 days' : range === '28d' ? '28 days' : '30 days';
                // Daily aggregates from the hourly materialized view
                result = await pool.query(
                    `SELECT
                         DATE_TRUNC('day', hour)                         AS hour,
                         MIN(min_unit_price)                             AS min_unit_price,
                         SUM(total_supply)                               AS total_supply,
                         EXTRACT(DOW FROM DATE_TRUNC('day', hour))::INT  AS day_of_week
                     FROM ah_price_hourly
                     WHERE item_id = $1
                       AND hour >= NOW() - INTERVAL '${interval}'
                     GROUP BY DATE_TRUNC('day', hour)
                     ORDER BY hour ASC`,
                    [itemId]
                );
            } else {
                result = await pool.query(
                    `SELECT hour, min_unit_price, total_supply
                     FROM ah_price_hourly
                     WHERE item_id = $1
                       AND hour >= NOW() - INTERVAL '24 hours'
                     ORDER BY hour ASC`,
                    [itemId]
                );
            }
            res.json(result.rows);
        } catch (err) {
            console.error('[api] GET /api/prices failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/prices/:item_id/weekly
    // Average price by day of week (0=Sun … 6=Sat), across all history.
    // Requires at least 2 weeks of data to be meaningful.
    // Returns: [{ day_of_week, avg_price, min_price, max_price, weeks_of_data }]
    // ----------------------------------------------------------------
    app.get('/api/prices/:item_id/weekly', async (req, res) => {
        const itemId = parseInt(req.params.item_id, 10);
        if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item_id' });

        try {
            const result = await pool.query(
                `WITH daily AS (
                     SELECT
                         DATE_TRUNC('day', hour)         AS day,
                         EXTRACT(DOW FROM hour)::INT     AS dow,
                         AVG(min_unit_price)::BIGINT     AS day_avg,
                         MIN(min_unit_price)             AS day_min
                     FROM ah_price_hourly
                     WHERE item_id = $1
                     GROUP BY DATE_TRUNC('day', hour), EXTRACT(DOW FROM hour)
                 )
                 SELECT
                     dow                         AS day_of_week,
                     COUNT(*)::INT               AS data_days,
                     AVG(day_avg)::BIGINT         AS avg_price,
                     MIN(day_min)                AS min_price,
                     MAX(day_avg)                AS max_price
                 FROM daily
                 GROUP BY dow
                 ORDER BY dow`,
                [itemId]
            );

            // Minimum data threshold: at least 2 data days per day-of-week slot
            // (roughly 2 weeks) before we consider the pattern meaningful
            const minDays = result.rows.length > 0 ? Math.min(...result.rows.map(r => Number(r.data_days))) : 0;
            res.json({ rows: result.rows, min_days: minDays, meaningful: minDays >= 2 });
        } catch (err) {
            console.error('[api] GET /api/prices/weekly failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/prices/:item_id/stats — current price snapshot for ticker cards
    // Returns: { current_price, price_24h_ago, change_24h, high_24h, low_24h }
    // ----------------------------------------------------------------
    app.get('/api/prices/:item_id/stats', async (req, res) => {
        const itemId = parseInt(req.params.item_id, 10);

        if (isNaN(itemId)) {
            return res.status(400).json({ error: 'Invalid item_id' });
        }

        try {
            // Most recent hourly bucket.
            // current_price = min_unit_price (the cheapest listing seen that hour).
            // median_unit_price skews high because the AH has many overpriced listings
            // and using it as "the price" made the app show 40-70g above actual floor.
            const currentResult = await pool.query(
                `SELECT min_unit_price AS current_price, median_unit_price AS current_median
                 FROM ah_price_hourly
                 WHERE item_id = $1
                 ORDER BY hour DESC
                 LIMIT 1`,
                [itemId]
            );

            if (currentResult.rows.length === 0) {
                return res.status(404).json({ error: 'No price data found for this item' });
            }

            // 24h high/low/old price
            const statsResult = await pool.query(
                `SELECT
                    MIN(min_unit_price)    AS low_24h,
                    MAX(min_unit_price)    AS high_24h,
                    -- The oldest bucket in the 24h window as the "24h ago" reference
                    (SELECT min_unit_price
                     FROM ah_price_hourly
                     WHERE item_id = $1
                       AND hour >= NOW() - INTERVAL '25 hours'
                     ORDER BY hour ASC
                     LIMIT 1)             AS price_24h_ago
                 FROM ah_price_hourly
                 WHERE item_id = $1
                   AND hour >= NOW() - INTERVAL '24 hours'`,
                [itemId]
            );

            const current = currentResult.rows[0];
            const stats   = statsResult.rows[0];

            const currentPrice  = Number(current.current_price);
            const price24hAgo   = Number(stats.price_24h_ago) || currentPrice;
            const change24h     = currentPrice - price24hAgo;
            const changePct24h  = price24hAgo > 0
                ? ((change24h / price24hAgo) * 100).toFixed(2)
                : '0.00';

            res.json({
                current_price:   currentPrice,
                current_median:  Number(current.current_median),
                price_24h_ago:   price24hAgo,
                change_24h:      change24h,
                change_pct_24h:  Number(changePct24h),
                high_24h:        Number(stats.high_24h),
                low_24h:         Number(stats.low_24h),
            });
        } catch (err) {
            console.error('[api] GET /api/prices/stats failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/profile — return the current user's profile
    // ----------------------------------------------------------------
    app.get('/api/profile', async (_req, res) => {
        try {
            const result = await pool.query(
                `SELECT * FROM profiles WHERE user_id = $1`, ['default']
            );
            // Return empty profile if row doesn't exist yet
            res.json(result.rows[0] ?? {
                user_id: 'default', display_name: 'My Profile',
                class: null, spec: null, faction: null, race: null,
                professions: [], profession_ranks: {}, reputations: {}, known_recipes: [],
            });
        } catch (err) {
            console.error('[api] GET /api/profile failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // PUT /api/profile — create or update the current user's profile
    // Body: { class, spec, faction, race, professions[] }
    // ----------------------------------------------------------------
    app.put('/api/profile', async (req, res) => {
        const { class: cls, spec, faction, race, professions, alchemy_spec } = req.body;
        try {
            const result = await pool.query(
                `INSERT INTO profiles (user_id, class, spec, faction, race, professions, alchemy_spec, updated_at)
                 VALUES ('default', $1, $2, $3, $4, $5, $6, NOW())
                 ON CONFLICT (user_id) DO UPDATE SET
                     class        = EXCLUDED.class,
                     spec         = EXCLUDED.spec,
                     faction      = EXCLUDED.faction,
                     race         = EXCLUDED.race,
                     professions  = EXCLUDED.professions,
                     alchemy_spec = EXCLUDED.alchemy_spec,
                     updated_at   = NOW()
                 RETURNING *`,
                [cls || null, spec || null, faction || null, race || null,
                 JSON.stringify(professions || []), alchemy_spec || 'Elixir Master']
            );
            res.json(result.rows[0]);
        } catch (err) {
            console.error('[api] PUT /api/profile failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/dashboard/deals
    // Items currently priced 25%+ below their 7-day average.
    // Requires at least 3 hourly data points to avoid false positives.
    // ----------------------------------------------------------------
    app.get('/api/dashboard/deals', async (_req, res) => {
        try {
            // Compare recent median to 30-day moving average — far more stable than
            // comparing raw snapshots which are thrown off by outlier listings.
            const result = await pool.query(`
                WITH ma AS (
                    SELECT item_id,
                           AVG(min_unit_price)::BIGINT AS moving_avg
                    FROM   ah_price_hourly
                    WHERE  hour >= NOW() - INTERVAL '30 days'
                    GROUP  BY item_id
                    HAVING COUNT(*) >= 10
                ),
                recent AS (
                    SELECT item_id,
                           AVG(min_unit_price)::BIGINT AS recent_price
                    FROM   ah_price_hourly
                    WHERE  hour >= NOW() - INTERVAL '24 hours'
                    GROUP  BY item_id
                    HAVING COUNT(*) >= 2
                )
                SELECT
                    r.item_id,
                    i.name,
                    r.recent_price                                            AS current_price,
                    m.moving_avg,
                    ROUND((1.0 - r.recent_price::float / m.moving_avg) * 100)::INT AS discount_pct
                FROM   recent r
                JOIN   ma m      ON m.item_id = r.item_id
                JOIN   items i   ON i.item_id = r.item_id
                WHERE  r.recent_price < m.moving_avg * 0.90   -- 10%+ below 30d MA
                  AND  m.moving_avg > 5000                    -- skip sub-50s junk
                ORDER  BY discount_pct DESC
                LIMIT  15
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('[api] GET /api/dashboard/deals failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/dashboard/motes
    // Mote → Primal arbitrage: compare primal price to 10× mote price.
    // Positive spread = buy 10 motes, combine, sell primal for profit.
    // ----------------------------------------------------------------
    const MOTE_PAIRS = [
        { mote: 'Mote of Fire',   primal: 'Primal Fire'   },
        { mote: 'Mote of Water',  primal: 'Primal Water'  },
        { mote: 'Mote of Air',    primal: 'Primal Air'    },
        { mote: 'Mote of Earth',  primal: 'Primal Earth'  },
        { mote: 'Mote of Shadow', primal: 'Primal Shadow' },
        { mote: 'Mote of Mana',   primal: 'Primal Mana'   },
        { mote: 'Mote of Life',   primal: 'Primal Life'   },
    ];

    app.get('/api/dashboard/motes', async (_req, res) => {
        try {
            const allNames = MOTE_PAIRS.flatMap(p => [p.mote, p.primal]);
            const result = await pool.query(
                `SELECT DISTINCT ON (i.name)
                     i.name, i.item_id,
                     aph.min_unit_price AS price,
                     aph.min_unit_price AS min_price
                 FROM items i
                 JOIN ah_price_hourly aph ON aph.item_id = i.item_id
                 WHERE i.name = ANY($1)
                 ORDER BY i.name, aph.hour DESC`,
                [allNames]
            );

            const priceMap = Object.fromEntries(result.rows.map(r => [r.name, r]));

            const pairs = MOTE_PAIRS.map(p => {
                const mote   = priceMap[p.mote];
                const primal = priceMap[p.primal];
                if (!mote || !primal) return null;
                const mote_price   = Number(mote.price);
                const primal_price = Number(primal.price);
                const bundle_cost  = mote_price * 10;
                const spread       = primal_price - bundle_cost;
                const spread_pct   = primal_price > 0
                    ? Math.round((spread / primal_price) * 100)
                    : 0;
                return {
                    mote_name:   p.mote,  primal_name: p.primal,
                    mote_id:     Number(mote.item_id),
                    primal_id:   Number(primal.item_id),
                    mote_price, primal_price, bundle_cost, spread, spread_pct,
                };
            }).filter(Boolean);

            pairs.sort((a, b) => b.spread - a.spread);
            res.json(pairs);
        } catch (err) {
            console.error('[api] GET /api/dashboard/motes failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/dashboard/movers
    // Items with the biggest price change over the last 24h vs prior week.
    // ----------------------------------------------------------------
    app.get('/api/dashboard/movers', async (_req, res) => {
        try {
            const result = await pool.query(`
                WITH recent AS (
                    SELECT item_id, AVG(min_unit_price) AS recent_avg
                    FROM   ah_price_hourly
                    WHERE  hour > NOW() - INTERVAL '24 hours'
                    GROUP  BY item_id
                    HAVING COUNT(*) >= 2
                ),
                prior AS (
                    SELECT item_id, AVG(min_unit_price) AS prior_avg
                    FROM   ah_price_hourly
                    WHERE  hour BETWEEN NOW() - INTERVAL '7 days'
                                    AND NOW() - INTERVAL '24 hours'
                    GROUP  BY item_id
                    HAVING COUNT(*) >= 5
                )
                SELECT
                    r.item_id,
                    COALESCE(i.name, 'Item #' || r.item_id) AS name,
                    ROUND(r.recent_avg)::BIGINT              AS current_price,
                    ROUND(p.prior_avg)::BIGINT               AS prev_price,
                    ROUND(((r.recent_avg - p.prior_avg) / NULLIF(p.prior_avg, 0)) * 100)::INT AS change_pct
                FROM   recent r
                JOIN   prior p ON p.item_id = r.item_id
                JOIN   items i ON i.item_id = r.item_id    -- INNER JOIN: skip unnamed items
                WHERE  p.prior_avg > 5000
                  AND  ABS((r.recent_avg - p.prior_avg) / NULLIF(p.prior_avg, 0)) > 0.10
                ORDER  BY ABS((r.recent_avg - p.prior_avg) / NULLIF(p.prior_avg, 0)) DESC
                LIMIT  10
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('[api] GET /api/dashboard/movers failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/dashboard/consumables
    // Returns consumables for the current profile's class/spec,
    // each annotated with current price and a buy/normal/high signal.
    // ----------------------------------------------------------------
    app.get('/api/dashboard/consumables', async (_req, res) => {
        try {
            const profileResult = await pool.query(
                `SELECT class, spec FROM profiles WHERE user_id = $1`, ['default']
            );
            const profile = profileResult.rows[0];

            if (!profile?.class || !profile?.spec) {
                return res.json({ items: [], needs_profile: true });
            }

            const consumables = getConsumablesForSpec(profile.class, profile.spec);
            if (!consumables.length) {
                return res.json({ items: [], role: getSpecRole(profile.class, profile.spec) });
            }

            // Look up prices by item NAME (same approach as the crafting endpoint)
            // so prices are consistent regardless of whether hardcoded item_ids match
            // the actual item_ids in this server's database.
            const names = consumables.map(c => c.name);

            const priceResult = await pool.query(
                `SELECT DISTINCT ON (i.name)
                        i.name, i.item_id, aph.min_unit_price AS current_price
                 FROM   items i
                 JOIN   ah_price_hourly aph ON aph.item_id = i.item_id
                 WHERE  i.name = ANY($1)
                 ORDER  BY i.name, aph.hour DESC`,
                [names]
            );

            const avgResult = await pool.query(
                `SELECT i.name, AVG(aph.min_unit_price) AS avg_price
                 FROM   items i
                 JOIN   ah_price_hourly aph ON aph.item_id = i.item_id
                 WHERE  i.name = ANY($1)
                   AND  aph.hour > NOW() - INTERVAL '7 days'
                 GROUP  BY i.name
                 HAVING COUNT(*) >= 2`,
                [names]
            );

            // Key maps by item name so lookups are name-accurate
            const priceMap = Object.fromEntries(
                priceResult.rows.map(r => [r.name, { item_id: r.item_id, current_price: Number(r.current_price) }])
            );
            const avgMap = Object.fromEntries(avgResult.rows.map(r => [r.name, Number(r.avg_price)]));

            const items = consumables.map(c => {
                const pd      = priceMap[c.name];
                const current = pd?.current_price ?? null;
                const item_id = pd?.item_id ?? c.item_id;  // fallback to hardcoded if not in DB yet
                const avg     = avgMap[c.name] ?? null;
                let signal = null;
                if (current && avg) {
                    const ratio = current / avg;
                    signal = ratio < 0.85 ? 'buy' : ratio > 1.15 ? 'high' : 'normal';
                }
                return { ...c, item_id, current_price: current, avg_price: avg ? Math.round(avg) : null, signal };
            });

            res.json({ items, role: getSpecRole(profile.class, profile.spec) });
        } catch (err) {
            console.error('[api] GET /api/dashboard/consumables failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/dashboard/crafting
    // Returns crafting profit estimates for the user's professions.
    // Looks up ingredient and output prices by item name from the items
    // table, so recipe definitions don't need hardcoded item IDs.
    // Vendor reagent costs (Imbued Vial, Crystal Vial) are calculated
    // from base vendor price with a reputation discount applied.
    // ----------------------------------------------------------------

    // TBC faction AH takes 5% of the final sale. Neutral goblin AH takes 15%.
    // Profit must account for this — listing at 2g and selling nets only 1g 90s.
    const AH_CUT = 0.05;

    // Base vendor costs in copper. Approximate TBC Classic prices.
    // Discounts are applied per WoW's standard reputation system.
    const VENDOR_BASE_COSTS = {
        'Imbued Vial':   800,   // 40s per 5 = 8s each — sold by Outland alchemy supply vendors
        'Crystal Vial':  100,   // 5s per 5 = 1s each — sold by alchemy supply vendors
    };
    // standingId → discount fraction (discounts begin at Honored)
    const REP_DISCOUNTS = { 4: 0, 5: 0, 6: 0.05, 7: 0.10, 8: 0.20 };
    // TBC Outland/capital factions whose vendors sell crafting reagents.
    // The best standing across these factions determines the vendor discount.
    const VENDOR_FACTIONS = [
        'Honor Hold', 'Thrallmar', 'Lower City', "The Sha'tar",
        'Cenarion Expedition', 'The Aldor', 'The Scryers',
        'Orgrimmar', 'Stormwind',
    ];

    app.get('/api/dashboard/crafting', async (_req, res) => {
        try {
            const profileResult = await pool.query(
                `SELECT professions, profession_ranks, reputations, known_recipes, alchemy_spec FROM profiles WHERE user_id = $1`,
                ['default']
            );
            const profile = profileResult.rows[0];
            if (!profile) return res.json({ items: [], needs_profile: true });

            const alchemySpec = profile.alchemy_spec || 'Elixir Master';

            const profs = Array.isArray(profile.professions)
                ? profile.professions
                : JSON.parse(profile.professions || '[]');

            if (!profs.length) return res.json({ items: [], needs_profile: true });

            // Vendor discount: best standing across relevant factions
            const reps = profile.reputations || {};
            const bestStanding = Math.max(4, ...VENDOR_FACTIONS.map(f => reps[f] ?? 4));
            const discount = REP_DISCOUNTS[Math.min(bestStanding, 8)] ?? 0;
            const vendorCost = (name) => {
                const base = VENDOR_BASE_COSTS[name];
                return base != null ? Math.round(base * (1 - discount)) : 0;
            };

            // Build a set of recipe names the character has actually learned,
            // exported by the in-game addon when the player opens their tradeskill
            // windows. If the addon hasn't synced yet the set is empty and we fall
            // back to skill-level-only filtering.
            const knownRecipes = Array.isArray(profile.known_recipes)
                ? profile.known_recipes
                : JSON.parse(profile.known_recipes || '[]');
            const knownNames = new Set(knownRecipes.map(r => r.output_name));
            const hasKnownRecipes = knownNames.size > 0;

            // Query recipe_catalog for all recipes belonging to this character's
            // professions. Ingredients come from CraftLib DB2 data (accurate).
            // Filter: if the addon has synced known recipes, show only those;
            // otherwise fall back to everything learnable at the character's skill rank.
            const profRanks = profile.profession_ranks || {};
            const catalogResult = await pool.query(
                `SELECT recipe_id, recipe_name, profession, output_item_id,
                        output_name, output_qty AS num_made, min_skill, materials
                 FROM recipe_catalog
                 WHERE profession = ANY($1)`,
                [profs]
            );

            const myRecipes = catalogResult.rows.filter(r => {
                const charRank = profRanks[r.profession] ?? 0;
                // Only filter by skill if we know the character's rank (from addon sync).
                // When professions are set manually via Settings, ranks default to 0
                // and we show all recipes rather than filtering everything out.
                if (charRank > 0 && r.min_skill > charRank) return false;
                if (hasKnownRecipes) return knownNames.has(r.recipe_name);
                return true;
            });

            if (!myRecipes.length) return res.json({ items: [], needs_profile: false });

            // Collect output item IDs and material names separately.
            // Output prices are looked up by item_id (immune to output_name data issues).
            // Material prices are looked up by name (CraftLib reagent names are accurate).
            const outputItemIds = [...new Set(myRecipes.map(r => r.output_item_id).filter(Boolean))];
            const matNames      = [...new Set(myRecipes.flatMap(r => r.materials.map(m => m.name)))];

            const priceSubquery = (col) =>
                `(SELECT aph2.min_unit_price FROM ah_price_hourly aph2
                  WHERE aph2.item_id = ${col} ORDER BY aph2.hour DESC LIMIT 1)`;

            const [outputPrices, matPrices] = await Promise.all([
                outputItemIds.length ? pool.query(
                    `SELECT i.item_id, i.name,
                            AVG(aph.min_unit_price) AS avg_price,
                            ${priceSubquery('i.item_id')} AS current_price,
                            i.tsm_num_auctions, i.tsm_market_value,
                            i.region_sold_per_day, i.region_sale_pct, i.region_market_value
                     FROM items i
                     JOIN ah_price_hourly aph ON aph.item_id = i.item_id
                     WHERE i.item_id = ANY($1)
                       AND aph.hour > NOW() - INTERVAL '7 days'
                     GROUP BY i.item_id, i.name, i.tsm_num_auctions, i.tsm_market_value,
                              i.region_sold_per_day, i.region_sale_pct, i.region_market_value`,
                    [outputItemIds]
                ) : { rows: [] },
                matNames.length ? pool.query(
                    `SELECT i.name, i.item_id,
                            AVG(aph.min_unit_price) AS avg_price,
                            ${priceSubquery('i.item_id')} AS current_price
                     FROM items i
                     JOIN ah_price_hourly aph ON aph.item_id = i.item_id
                     WHERE i.name = ANY($1)
                       AND aph.hour > NOW() - INTERVAL '7 days'
                     GROUP BY i.name, i.item_id`,
                    [matNames]
                ) : { rows: [] },
            ]);

            // priceById: for output price lookups (keyed by item_id)
            const priceById = Object.fromEntries(
                outputPrices.rows.map(r => [r.item_id, {
                    item_id:       r.item_id,
                    name:          r.name,
                    avg_price:     Number(r.avg_price),
                    current_price: r.current_price != null ? Number(r.current_price) : null,
                    market_context: {
                        tsm_num_auctions:    r.tsm_num_auctions    != null ? Number(r.tsm_num_auctions)    : null,
                        tsm_market_value:    r.tsm_market_value    != null ? Number(r.tsm_market_value)    : null,
                        region_sold_per_day: r.region_sold_per_day != null ? Number(r.region_sold_per_day) : null,
                        region_sale_pct:     r.region_sale_pct     != null ? Number(r.region_sale_pct)     : null,
                        region_market_value: r.region_market_value != null ? Number(r.region_market_value) : null,
                    },
                }])
            );
            // priceMap: for material price lookups (keyed by name)
            const priceMap = Object.fromEntries(
                matPrices.rows.map(r => [r.name, {
                    item_id:       r.item_id,
                    avg_price:     Number(r.avg_price),
                    current_price: r.current_price != null ? Number(r.current_price) : null,
                }])
            );

            const VENDOR_ITEMS = new Set(Object.keys(VENDOR_BASE_COSTS));

            const results = myRecipes.map(recipe => {
                // Look up output price by item_id when available (robust against
                // output_name mismatches like transmute spell names in CraftLib data).
                const output = recipe.output_item_id
                    ? priceById[recipe.output_item_id]
                    : priceMap[recipe.output_name];
                if (!output?.current_price) {
                    return { ...recipe, output_price: null, material_cost: null, profit: null, profit_pct: null };
                }

                // Material cost = sum of (qty × price) per ingredient.
                // Use current_price (most recent median) for mats so the cost reflects
                // what you'd actually pay on the AH today, not a depressed 7-day average
                // that can be skewed by a single cheap dump listing.
                // Falls back to avg_price only if no recent data exists for that item.
                // Vendor reagents (vials): use vendor base cost with rep discount applied.
                // AH ingredients with no price at all = incomplete; profit is nulled out.
                let material_cost = 0;
                const missing = [];
                for (const mat of recipe.materials) {
                    const p = priceMap[mat.name];
                    const matPrice = p?.current_price ?? p?.avg_price ?? null;
                    if (matPrice) {
                        material_cost += mat.qty * matPrice;
                    } else if (VENDOR_ITEMS.has(mat.name)) {
                        material_cost += mat.qty * vendorCost(mat.name);
                    } else {
                        missing.push(mat.name);
                    }
                }

                const num_made        = recipe.num_made ?? 1;
                const output_price    = output.current_price * num_made;
                // Net proceeds after the AH cut — this is what actually lands in your bag
                const net_proceeds    = Math.round(output_price * (1 - AH_CUT));
                const profitKnown     = missing.length === 0;
                const profit          = profitKnown ? net_proceeds - material_cost : null;
                const profit_pct      = profitKnown && material_cost > 0
                    ? Math.round((profit / material_cost) * 100)
                    : null;

                // Market context from TSM (liquidity signals, not prices)
                const ctx = output.market_context ?? {};

                // Alchemy proc EV model
                const alchemy_type    = classifyAlchemyType(recipe.profession, recipe.recipe_name, recipe.output_name);
                const proc_yield      = alchemyProcYield(alchemy_type, alchemySpec);
                const expected_margin = profitKnown
                    ? Math.round(net_proceeds * proc_yield - material_cost)
                    : null;
                // Break-even safety: mat cost < 10% of net proceeds → survive 90% price crash
                const break_even_safe = profitKnown && net_proceeds > 0
                    ? material_cost < net_proceeds * 0.1
                    : false;
                // Daily capacity: transmutes are hard-capped at 1/day (24h cooldown).
                // For everything else, use TSM regional velocity as a soft ceiling.
                const region_spd      = ctx.region_sold_per_day != null ? Number(ctx.region_sold_per_day) : null;
                const daily_cap       = alchemy_type === 'transmute'
                    ? 1
                    : region_spd != null ? Math.max(1, Math.round(region_spd)) : null;

                return {
                    profession:          recipe.profession,
                    output_name:         recipe.output_name,
                    output_id:           output.item_id,
                    num_made,
                    output_price,
                    material_cost:       profitKnown ? Math.round(material_cost) : null,
                    profit,
                    profit_pct,
                    missing_mats:        missing,
                    materials:           recipe.materials,   // [{name,qty}] for client-side timing cross-ref
                    // Alchemy EV model
                    alchemy_type,
                    proc_yield,
                    expected_margin,
                    break_even_safe,
                    daily_cap,
                    // TSM market intelligence
                    tsm_num_auctions:    ctx.tsm_num_auctions    ?? null,
                    region_sold_per_day: region_spd,
                    region_sale_pct:     ctx.region_sale_pct     ?? null,
                    region_market_value: ctx.region_market_value ?? null,
                    tsm_market_value:    ctx.tsm_market_value    ?? null,
                };
            });

            // Sort by proc-adjusted expected gold/day.
            // For alchemy, use expected_margin (incorporates proc yield) × velocity.
            // Items with no velocity data fall back to raw margin ranking.
            // Unknowns (null profit) always go last.
            const expectedGoldPerDay = (r) => {
                if (r.profit == null) return -Infinity;
                const margin = r.expected_margin ?? r.profit;
                const vel    = r.region_sold_per_day;
                return vel != null ? margin * vel : margin * 0.5;
            };
            results.sort((a, b) => expectedGoldPerDay(b) - expectedGoldPerDay(a));

            // ── Gather vs Craft ───────────────────────────────────────────
            // For each gatherable ingredient across all recipes, compare its
            // raw AH price to the effective value of using it in the best recipe.
            // effective_value = (output_price - cost_of_other_mats) / qty_of_this_ingredient
            const ingredientValues = {};
            for (const recipe of myRecipes) {
                const output = recipe.output_item_id
                    ? priceById[recipe.output_item_id]
                    : priceMap[recipe.output_name];
                if (!output?.current_price) continue;
                const outputPrice = output.current_price * (recipe.num_made ?? 1);

                for (const targetMat of recipe.materials) {
                    if (VENDOR_ITEMS.has(targetMat.name)) continue;
                    const rawPrice = priceMap[targetMat.name]?.current_price
                                  ?? priceMap[targetMat.name]?.avg_price;
                    if (!rawPrice) continue;

                    let otherCost = 0;
                    let skip = false;
                    for (const mat of recipe.materials) {
                        if (mat.name === targetMat.name) continue;
                        if (VENDOR_ITEMS.has(mat.name)) {
                            otherCost += mat.qty * vendorCost(mat.name);
                        } else {
                            const p = priceMap[mat.name]?.current_price ?? priceMap[mat.name]?.avg_price;
                            if (p) otherCost += mat.qty * p;
                            else { skip = true; break; }
                        }
                    }
                    if (skip) continue;

                    const effectiveValue = (outputPrice - otherCost) / targetMat.qty;
                    if (effectiveValue <= 0) continue;

                    const existing = ingredientValues[targetMat.name];
                    if (!existing || effectiveValue > existing.craft_value) {
                        ingredientValues[targetMat.name] = {
                            name:           targetMat.name,
                            raw_price:      rawPrice,
                            craft_value:    Math.round(effectiveValue),
                            best_recipe:    recipe.output_name,
                            best_recipe_id: output.item_id,
                        };
                    }
                }
            }

            const craft_vs_sell = Object.values(ingredientValues)
                .map(d => ({
                    ...d,
                    action:  d.craft_value > d.raw_price ? 'CRAFT' : 'SELL',
                    gap:     d.craft_value - d.raw_price,
                    gap_pct: Math.round(((d.craft_value - d.raw_price) / d.raw_price) * 100),
                }))
                .sort((a, b) => Math.abs(b.gap_pct) - Math.abs(a.gap_pct));

            res.json({ items: results, craft_vs_sell, alchemy_spec: alchemySpec });
        } catch (err) {
            console.error('[api] GET /api/dashboard/crafting failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/dashboard/flask-strategy
    // All TBC flask recipes with proc economics — no known_recipes filter.
    // Shows every flask regardless of whether the character has learned it.
    // ----------------------------------------------------------------
    app.get('/api/dashboard/flask-strategy', async (_req, res) => {
        try {
            const profileResult = await pool.query(
                `SELECT alchemy_spec, reputations FROM profiles WHERE user_id = 'default'`
            );
            const prof = profileResult.rows[0];
            const alchemySpec = prof?.alchemy_spec || 'Elixir Master';
            const reps = prof?.reputations || {};
            const bestStanding = Math.max(4, ...VENDOR_FACTIONS.map(f => reps[f] ?? 4));
            const discount = REP_DISCOUNTS[Math.min(bestStanding, 8)] ?? 0;
            const vendorCost = (name) => {
                const base = VENDOR_BASE_COSTS[name];
                return base != null ? Math.round(base * (1 - discount)) : 0;
            };

            const catalogResult = await pool.query(
                `SELECT recipe_id, recipe_name, profession, output_item_id,
                        output_name, output_qty AS num_made, min_skill, materials
                 FROM recipe_catalog
                 WHERE profession = 'Alchemy'
                   AND recipe_name NOT LIKE 'Transmute:%'
                   AND output_name ILIKE '%flask%'`
            );
            if (!catalogResult.rows.length) return res.json({ items: [], alchemy_spec: alchemySpec });

            const outputItemIds = [...new Set(catalogResult.rows.map(r => r.output_item_id).filter(Boolean))];
            const matNames      = [...new Set(catalogResult.rows.flatMap(r => r.materials.map(m => m.name)))];

            const priceSubquery = (col) =>
                `(SELECT aph2.min_unit_price FROM ah_price_hourly aph2
                  WHERE aph2.item_id = ${col} ORDER BY aph2.hour DESC LIMIT 1)`;

            const [outputPrices, matPrices] = await Promise.all([
                outputItemIds.length ? pool.query(
                    `SELECT i.item_id, i.name,
                            ${priceSubquery('i.item_id')} AS current_price,
                            i.region_sold_per_day, i.region_sale_pct
                     FROM items i
                     WHERE i.item_id = ANY($1)`,
                    [outputItemIds]
                ) : { rows: [] },
                matNames.length ? pool.query(
                    `SELECT i.name, i.item_id,
                            AVG(aph.min_unit_price) AS avg_price,
                            ${priceSubquery('i.item_id')} AS current_price
                     FROM items i
                     JOIN ah_price_hourly aph ON aph.item_id = i.item_id
                     WHERE i.name = ANY($1)
                       AND aph.hour > NOW() - INTERVAL '7 days'
                     GROUP BY i.name, i.item_id`,
                    [matNames]
                ) : { rows: [] },
            ]);

            const priceById = Object.fromEntries(outputPrices.rows.map(r => [r.item_id, r]));
            const priceMap  = Object.fromEntries(matPrices.rows.map(r => [r.name, r]));
            const VENDOR_ITEMS = new Set(Object.keys(VENDOR_BASE_COSTS));

            const items = catalogResult.rows.map(recipe => {
                const output = priceById[recipe.output_item_id];
                const outputPrice = output?.current_price != null ? Number(output.current_price) * (recipe.num_made ?? 1) : null;

                let material_cost = 0;
                const missing = [];
                for (const mat of recipe.materials) {
                    const p = priceMap[mat.name];
                    const matPrice = p?.current_price != null ? Number(p.current_price)
                                   : p?.avg_price != null ? Number(p.avg_price) : null;
                    if (matPrice != null) material_cost += mat.qty * matPrice;
                    else if (VENDOR_ITEMS.has(mat.name)) material_cost += mat.qty * vendorCost(mat.name);
                    else missing.push(mat.name);
                }

                const proc_yield      = alchemyProcYield('flask', alchemySpec);
                const net_proceeds    = outputPrice != null ? Math.round(outputPrice * (1 - AH_CUT)) : null;
                const profitKnown     = outputPrice != null && missing.length === 0;
                const profit          = profitKnown ? net_proceeds - Math.round(material_cost) : null;
                const expected_margin = profitKnown ? Math.round(net_proceeds * proc_yield - material_cost) : null;
                const region_spd      = output?.region_sold_per_day != null ? Number(output.region_sold_per_day) : null;

                return {
                    output_name:         recipe.output_name,
                    output_id:           recipe.output_item_id != null ? Number(recipe.output_item_id) : null,
                    min_skill:           recipe.min_skill,
                    output_price:        outputPrice != null ? Math.round(outputPrice) : null,
                    material_cost:       profitKnown ? Math.round(material_cost) : null,
                    profit,
                    profit_pct:          profitKnown && material_cost > 0 ? Math.round((profit / material_cost) * 100) : null,
                    missing_mats:        missing,
                    materials:           recipe.materials,
                    alchemy_type:        'flask',
                    proc_yield,
                    expected_margin,
                    region_sold_per_day: region_spd,
                    region_sale_pct:     output?.region_sale_pct != null ? Number(output.region_sale_pct) : null,
                };
            });

            // Sort: known price + profitable first, then by EV/day, no-price last
            items.sort((a, b) => {
                const ev = r => {
                    const m = r.expected_margin ?? r.profit;
                    if (m == null) return -Infinity;
                    return m * (r.region_sold_per_day ?? 0.5);
                };
                return ev(b) - ev(a);
            });

            res.json({ items, alchemy_spec: alchemySpec });
        } catch (err) {
            console.error('[api] GET /api/dashboard/flask-strategy failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/prices/recipe?output_id=X&range=7d
    // Price history for a crafted item plus all its material ingredients,
    // returned as parallel arrays so the frontend can plot them together.
    // ----------------------------------------------------------------
    app.get('/api/prices/recipe', async (req, res) => {
        const outputItemId = parseInt(req.query.output_id, 10);
        const range        = req.query.range || '7d';
        if (isNaN(outputItemId)) return res.status(400).json({ error: 'Invalid output_id' });

        try {
            const recipeResult = await pool.query(
                `SELECT output_name, materials FROM recipe_catalog
                 WHERE output_item_id = $1 LIMIT 1`,
                [outputItemId]
            );
            if (!recipeResult.rows.length) {
                return res.status(404).json({ error: 'Recipe not found' });
            }

            const { output_name, materials } = recipeResult.rows[0];
            const matNames = materials.map(m => m.name);

            // Resolve material names → item_ids
            const matItemsResult = await pool.query(
                `SELECT item_id, name FROM items WHERE name = ANY($1)`,
                [matNames]
            );
            const matIdByName = Object.fromEntries(
                matItemsResult.rows.map(r => [r.name, Number(r.item_id)])
            );

            const allIds = [outputItemId, ...Object.values(matIdByName)];

            const interval = range === '30d' ? '30 days' : range === '7d' ? '7 days' : '24 hours';
            const isDaily  = range !== '24h';

            const priceResult = await pool.query(
                isDaily
                    ? `SELECT item_id,
                              DATE_TRUNC('day', hour) AS hour,
                              MIN(min_unit_price)     AS price
                       FROM ah_price_hourly
                       WHERE item_id = ANY($1)
                         AND hour >= NOW() - INTERVAL '${interval}'
                       GROUP BY item_id, DATE_TRUNC('day', hour)
                       ORDER BY item_id, hour`
                    : `SELECT item_id, hour, min_unit_price AS price
                       FROM ah_price_hourly
                       WHERE item_id = ANY($1)
                         AND hour >= NOW() - INTERVAL '${interval}'
                       ORDER BY item_id, hour`,
                [allIds]
            );

            // Group rows by item_id
            const grouped = {};
            for (const row of priceResult.rows) {
                const id = Number(row.item_id);
                if (!grouped[id]) grouped[id] = [];
                grouped[id].push({ hour: row.hour, price: Number(row.price) });
            }

            res.json({
                output: {
                    item_id: outputItemId,
                    name:    output_name,
                    data:    grouped[outputItemId] || [],
                },
                materials: materials.map(m => ({
                    name:    m.name,
                    qty:     m.qty,
                    item_id: matIdByName[m.name] ?? null,
                    data:    matIdByName[m.name] ? (grouped[matIdByName[m.name]] || []) : [],
                })),
            });
        } catch (err) {
            console.error('[api] GET /api/prices/recipe failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/dashboard/alchemy-market
    // All alchemy mats and recipe outputs with current price vs 7d MA.
    // Returns items sorted by |deviation|; omits items with < 2 days of data.
    // ----------------------------------------------------------------
    app.get('/api/dashboard/alchemy-market', async (req, res) => {
        try {
            const tbcOnly = req.query.tbc === '1';
            const catalogResult = await pool.query(
                `SELECT output_item_id, materials FROM recipe_catalog WHERE profession = 'Alchemy'` +
                (tbcOnly ? ` AND min_skill >= 275` : '')
            );

            const outputIds = [...new Set(catalogResult.rows.map(r => r.output_item_id).filter(Boolean))];
            const matNames  = [...new Set(catalogResult.rows.flatMap(r =>
                Array.isArray(r.materials) ? r.materials.map(m => m.name) : []
            ))];

            if (!outputIds.length && !matNames.length) return res.json([]);

            const lastPrice = (col) =>
                `(SELECT aph2.min_unit_price FROM ah_price_hourly aph2 WHERE aph2.item_id = ${col} ORDER BY aph2.hour DESC LIMIT 1)`;

            const [outputResult, matResult] = await Promise.all([
                outputIds.length ? pool.query(`
                    SELECT i.item_id, i.name, 'output' AS role,
                           ${lastPrice('i.item_id')}               AS current_price,
                           AVG(aph.min_unit_price)::BIGINT          AS ma_7d,
                           COUNT(DISTINCT DATE_TRUNC('day', aph.hour)) AS scan_days
                    FROM items i
                    JOIN ah_price_hourly aph ON aph.item_id = i.item_id
                    WHERE i.item_id = ANY($1)
                      AND i.name IS NOT NULL
                      AND aph.hour > NOW() - INTERVAL '7 days'
                    GROUP BY i.item_id, i.name
                    HAVING COUNT(DISTINCT DATE_TRUNC('day', aph.hour)) >= 2`,
                    [outputIds]) : { rows: [] },

                matNames.length ? pool.query(`
                    SELECT i.item_id, i.name, 'mat' AS role,
                           ${lastPrice('i.item_id')}               AS current_price,
                           AVG(aph.min_unit_price)::BIGINT          AS ma_7d,
                           COUNT(DISTINCT DATE_TRUNC('day', aph.hour)) AS scan_days
                    FROM items i
                    JOIN ah_price_hourly aph ON aph.item_id = i.item_id
                    WHERE i.name = ANY($1)
                      AND aph.hour > NOW() - INTERVAL '7 days'
                    GROUP BY i.item_id, i.name
                    HAVING COUNT(DISTINCT DATE_TRUNC('day', aph.hour)) >= 2`,
                    [matNames]) : { rows: [] },
            ]);

            // Deduplicate by item_id; outputs take precedence over mats
            const seen = new Set();
            const all  = [];
            for (const r of [...outputResult.rows, ...matResult.rows]) {
                if (seen.has(Number(r.item_id))) continue;
                seen.add(Number(r.item_id));
                const cur = Number(r.current_price);
                const ma  = Number(r.ma_7d);
                if (!cur || !ma) continue;
                all.push({
                    item_id:       Number(r.item_id),
                    name:          r.name,
                    role:          r.role,
                    current_price: cur,
                    ma_7d:         ma,
                    pct_vs_ma:     Math.round(((cur - ma) / ma) * 100),
                    scan_days:     Number(r.scan_days),
                });
            }

            all.sort((a, b) => Math.abs(b.pct_vs_ma) - Math.abs(a.pct_vs_ma));
            res.json(all);
        } catch (err) {
            console.error('[api] GET /api/dashboard/alchemy-market failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // PATCH /api/profile/alchemy-spec — quick update without full profile save
    // Body: { alchemy_spec: 'Elixir Master' | 'Potion Master' }
    // ----------------------------------------------------------------
    app.patch('/api/profile/alchemy-spec', async (req, res) => {
        const { alchemy_spec } = req.body;
        const valid = ['Elixir Master', 'Potion Master', 'Transmutation Master'];
        if (!valid.includes(alchemy_spec)) return res.status(400).json({ error: 'Invalid spec' });
        try {
            await pool.query(
                `INSERT INTO profiles (user_id, alchemy_spec, updated_at)
                 VALUES ('default', $1, NOW())
                 ON CONFLICT (user_id) DO UPDATE SET
                     alchemy_spec = EXCLUDED.alchemy_spec,
                     updated_at   = NOW()`,
                [alchemy_spec]
            );
            res.json({ alchemy_spec });
        } catch (err) {
            console.error('[api] PATCH /api/profile/alchemy-spec failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/sales/history?days=30&limit=30
    // Top items by revenue from TSM personal sell history.
    // ----------------------------------------------------------------
    app.get('/api/sales/history', async (req, res) => {
        const days  = Math.min(parseInt(req.query.days  || '30', 10), 365);
        const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
        try {
            const result = await pool.query(
                `SELECT
                     sh.item_id,
                     COALESCE(i.name, 'Item #' || sh.item_id) AS name,
                     COUNT(*)                                   AS transactions,
                     SUM(sh.quantity)                           AS total_qty,
                     SUM(sh.quantity * sh.price_per_unit)       AS total_revenue,
                     AVG(sh.price_per_unit)::BIGINT             AS avg_price,
                     MAX(sh.sold_at)                            AS last_sold
                 FROM sales_history sh
                 LEFT JOIN items i ON i.item_id = sh.item_id
                 WHERE sh.sold_at >= NOW() - INTERVAL '${days} days'
                   AND sh.source IN ('Auction','Trade','COD')
                 GROUP BY sh.item_id, i.name
                 ORDER BY total_revenue DESC
                 LIMIT $1`,
                [limit]
            );
            res.json(result.rows.map(r => ({
                item_id:       Number(r.item_id),
                name:          r.name,
                transactions:  Number(r.transactions),
                total_qty:     Number(r.total_qty),
                total_revenue: Number(r.total_revenue),
                avg_price:     Number(r.avg_price),
                last_sold:     r.last_sold,
            })));
        } catch (err) {
            console.error('[api] GET /api/sales/history failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ----------------------------------------------------------------
    // GET /api/sales/summary?days=30
    // Aggregate stats: total revenue, total transactions, top item
    // ----------------------------------------------------------------
    app.get('/api/sales/summary', async (req, res) => {
        const days = Math.min(parseInt(req.query.days || '30', 10), 365);
        try {
            const result = await pool.query(`
                SELECT
                    COUNT(*)                             AS total_transactions,
                    SUM(quantity * price_per_unit)       AS total_revenue,
                    SUM(quantity)                        AS total_qty
                FROM sales_history
                WHERE sold_at >= NOW() - INTERVAL '${days} days'
                  AND source IN ('Auction','Trade','COD')
            `);
            res.json({
                days,
                total_transactions: Number(result.rows[0].total_transactions),
                total_revenue:      Number(result.rows[0].total_revenue),
                total_qty:          Number(result.rows[0].total_qty),
            });
        } catch (err) {
            console.error('[api] GET /api/sales/summary failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    return app;
}
