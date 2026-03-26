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
    // GET /api/prices/:item_id — last 24h of hourly price data
    // Returns an array of { hour, min_unit_price, avg_unit_price, median_unit_price, total_supply }
    // Prices are in copper — the frontend divides by 10000 for gold display
    // ----------------------------------------------------------------
    app.get('/api/prices/:item_id', async (req, res) => {
        const itemId = parseInt(req.params.item_id, 10);

        if (isNaN(itemId)) {
            return res.status(400).json({ error: 'Invalid item_id' });
        }

        try {
            const result = await pool.query(
                `SELECT hour, min_unit_price, avg_unit_price, median_unit_price, total_supply
                 FROM ah_price_hourly
                 WHERE item_id = $1
                   AND hour >= NOW() - INTERVAL '24 hours'
                 ORDER BY hour ASC`,
                [itemId]
            );
            res.json(result.rows);
        } catch (err) {
            console.error('[api] GET /api/prices failed:', err.message);
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
            // Most recent hourly bucket
            const currentResult = await pool.query(
                `SELECT median_unit_price AS current_price, min_unit_price AS current_min
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
                    MAX(median_unit_price) AS high_24h,
                    -- The oldest bucket in the 24h window as the "24h ago" reference
                    (SELECT median_unit_price
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
                current_price:  currentPrice,
                current_min:    Number(current.current_min),
                price_24h_ago:  price24hAgo,
                change_24h:     change24h,
                change_pct_24h: Number(changePct24h),
                high_24h:       Number(stats.high_24h),
                low_24h:        Number(stats.low_24h),
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
        const { class: cls, spec, faction, race, professions } = req.body;
        try {
            const result = await pool.query(
                `INSERT INTO profiles (user_id, class, spec, faction, race, professions, updated_at)
                 VALUES ('default', $1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (user_id) DO UPDATE SET
                     class        = EXCLUDED.class,
                     spec         = EXCLUDED.spec,
                     faction      = EXCLUDED.faction,
                     race         = EXCLUDED.race,
                     professions  = EXCLUDED.professions,
                     updated_at   = NOW()
                 RETURNING *`,
                [cls || null, spec || null, faction || null, race || null,
                 JSON.stringify(professions || [])]
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
            const result = await pool.query(`
                WITH current_prices AS (
                    SELECT item_id, MIN(buyout) AS min_buyout
                    FROM   ah_snapshots
                    WHERE  scanned_at > NOW() - INTERVAL '2 hours'
                    GROUP  BY item_id
                ),
                historical AS (
                    SELECT item_id,
                           AVG(min_unit_price) AS avg_price,
                           COUNT(*)            AS data_points
                    FROM   ah_price_hourly
                    WHERE  hour > NOW() - INTERVAL '7 days'
                    GROUP  BY item_id
                    HAVING COUNT(*) >= 3
                )
                SELECT
                    cp.item_id,
                    COALESCE(i.name, 'Item #' || cp.item_id)   AS name,
                    cp.min_buyout                               AS current_price,
                    ROUND(h.avg_price)::BIGINT                  AS avg_price,
                    ROUND((1.0 - cp.min_buyout / h.avg_price) * 100)::INT AS discount_pct
                FROM   current_prices cp
                JOIN   historical h ON h.item_id = cp.item_id
                JOIN   items i ON i.item_id = cp.item_id   -- INNER JOIN: skip unnamed items
                WHERE  cp.min_buyout < h.avg_price * 0.75
                  AND  h.avg_price > 5000       -- ignore sub-50-silver junk
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
                        i.name, i.item_id, aph.median_unit_price AS current_price
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

    // Base vendor costs in copper. Approximate TBC Classic prices.
    // Discounts are applied per WoW's standard reputation system.
    const VENDOR_BASE_COSTS = {
        'Imbued Vial':  4000,   // ~40s — sold by Outland alchemy supply vendors
        'Crystal Vial': 2000,   // ~20s — sold by alchemy supply vendors
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
                `SELECT professions, profession_ranks, reputations, known_recipes FROM profiles WHERE user_id = $1`,
                ['default']
            );
            const profile = profileResult.rows[0];
            if (!profile) return res.json({ items: [], needs_profile: true });

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
                if (r.min_skill > charRank) return false;
                if (hasKnownRecipes) return knownNames.has(r.recipe_name);
                return true;
            });

            if (!myRecipes.length) return res.json({ items: [], needs_profile: false });

            // Collect all unique item names we need prices for
            const allNames = new Set();
            for (const r of myRecipes) {
                allNames.add(r.output_name);
                r.materials.forEach(m => allNames.add(m.name));
            }

            // Look up item_ids by name, then get 7-day avg price for each
            const nameList = [...allNames];
            const priceResult = await pool.query(
                `SELECT i.name, i.item_id,
                        AVG(aph.median_unit_price) AS avg_price,
                        -- Most recent hourly price (not limited to 2 hours so stale scans still work)
                        (SELECT aph2.median_unit_price
                         FROM ah_price_hourly aph2
                         WHERE aph2.item_id = i.item_id
                         ORDER BY aph2.hour DESC LIMIT 1) AS current_price
                 FROM items i
                 JOIN ah_price_hourly aph ON aph.item_id = i.item_id
                 WHERE i.name = ANY($1)
                   AND aph.hour > NOW() - INTERVAL '7 days'
                 GROUP BY i.name, i.item_id`,
                [nameList]
            );

            // Build a name → { avg_price, current_price } map
            const priceMap = Object.fromEntries(
                priceResult.rows.map(r => [r.name, {
                    item_id:       r.item_id,
                    avg_price:     Number(r.avg_price),
                    current_price: r.current_price != null ? Number(r.current_price) : null,
                }])
            );

            const VENDOR_ITEMS = new Set(Object.keys(VENDOR_BASE_COSTS));

            const results = myRecipes.map(recipe => {
                const output = priceMap[recipe.output_name];
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
                const profitKnown     = missing.length === 0;
                const profit          = profitKnown ? output_price - material_cost : null;
                const profit_pct      = profitKnown && material_cost > 0
                    ? Math.round((profit / material_cost) * 100)
                    : null;

                return {
                    profession:    recipe.profession,
                    output_name:   recipe.output_name,
                    output_id:     output.item_id,
                    num_made,
                    output_price,
                    material_cost: profitKnown ? Math.round(material_cost) : null,
                    profit,
                    profit_pct,
                    missing_mats:  missing,
                };
            });

            // Sort by profit descending, put unknowns at the end
            results.sort((a, b) => {
                if (a.profit === null && b.profit === null) return 0;
                if (a.profit === null) return 1;
                if (b.profit === null) return -1;
                return b.profit - a.profit;
            });

            // ── Gather vs Craft ───────────────────────────────────────────
            // For each gatherable ingredient across all recipes, compare its
            // raw AH price to the effective value of using it in the best recipe.
            // effective_value = (output_price - cost_of_other_mats) / qty_of_this_ingredient
            const ingredientValues = {};
            for (const recipe of myRecipes) {
                const output = priceMap[recipe.output_name];
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

            res.json({ items: results, craft_vs_sell });
        } catch (err) {
            console.error('[api] GET /api/dashboard/crafting failed:', err.message);
            res.status(500).json({ error: 'Database error' });
        }
    });

    return app;
}
