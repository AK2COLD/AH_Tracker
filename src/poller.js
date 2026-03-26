/**
 * poller.js — Blizzard Auction House data fetcher
 *
 * This module is responsible for one thing: fetching all active auction
 * listings from the Blizzard API and writing them to the database.
 *
 * It is intentionally crash-proof — any error is caught and logged,
 * so the scheduler in index.js keeps running through transient failures.
 */

import 'dotenv/config';
import { getAccessToken } from './auth.js';
import { bulkInsertSnapshots } from './db.js';

const {
    BNET_REGION,
    CONNECTED_REALM_ID,
    BNET_NAMESPACE,
} = process.env;

/**
 * Fetches all auctions for the configured realm and inserts them into the DB.
 * Safe to call on any interval — errors are caught and logged, never thrown.
 */
export async function pollAuctions() {
    const startTime = Date.now();
    console.log(`[poller] Starting poll at ${new Date().toISOString()} — realm=${CONNECTED_REALM_ID} namespace=${BNET_NAMESPACE}`);

    try {
        const token = await getAccessToken();
        const auctions = await fetchAuctions(token);

        // Filter out bid-only listings — they have no buyout price
        // and can't be tracked meaningfully as a market price signal
        const buyoutAuctions = auctions.filter(a => a.buyout && a.buyout > 0);

        console.log(`[poller] Fetched ${auctions.length} auctions, ${buyoutAuctions.length} have buyout prices`);

        const scannedAt = new Date().toISOString();

        const rows = buyoutAuctions.map(auction => ({
            item_id:   auction.item.id,
            buyout:    auction.buyout,
            quantity:  auction.quantity,
            time_left: auction.time_left,
            scanned_at: scannedAt,
        }));

        await bulkInsertSnapshots(rows);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[poller] Inserted ${rows.length} rows in ${elapsed}s`);

        // Refresh the materialized view so chart queries reflect the new data.
        // This is a non-blocking best-effort refresh — if it fails, old chart
        // data is still served, which is acceptable.
        await refreshMaterializedView();

    } catch (err) {
        // Log the error but DO NOT re-throw — this keeps the cron job alive
        console.error('[poller] Poll failed:', err.message);
    }
}

// Fetch only the Horde AH (id=6).
// Add { id: 2, name: 'Alliance' } or { id: 7, name: 'Neutral' } here if needed later.
const CLASSIC_AH_IDS = [
    { id: 6, name: 'Horde' },
];

/**
 * Fetches all auctions from all Classic faction auction houses and merges them.
 * Classic WoW API requires /auctions/{auctionHouseId} — there is no combined endpoint.
 */
async function fetchAuctions(token) {
    const results = await Promise.all(
        CLASSIC_AH_IDS.map(ah => fetchAuctionHouse(token, ah.id, ah.name))
    );

    // Flatten all AH arrays into one combined list
    return results.flat();
}

/**
 * Fetches a single auction house by ID.
 * Returns an empty array if the AH doesn't exist on this realm (404).
 */
async function fetchAuctionHouse(token, auctionHouseId, ahName) {
    const url = new URL(
        `https://${BNET_REGION}.api.blizzard.com` +
        `/data/wow/connected-realm/${CONNECTED_REALM_ID}/auctions/${auctionHouseId}`
    );

    url.searchParams.set('namespace', BNET_NAMESPACE);
    url.searchParams.set('locale', 'en_US');
    url.searchParams.set('access_token', token);

    const response = await fetch(url.toString());

    // 404 means this AH type doesn't exist on the realm — not an error
    if (response.status === 404) {
        console.log(`[poller] ${ahName} AH (id=${auctionHouseId}) not found on this realm — skipping`);
        return [];
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Blizzard API error on ${ahName} AH: ${response.status} ${text}`);
    }

    const data = await response.json();

    if (!Array.isArray(data.auctions)) {
        throw new Error(`Unexpected API response for ${ahName} AH — "auctions" array not found`);
    }

    console.log(`[poller] ${ahName} AH: ${data.auctions.length} auctions`);
    return data.auctions;
}

/**
 * Refreshes the ah_price_hourly materialized view.
 * Called after each successful insert so charts stay up to date.
 */
async function refreshMaterializedView() {
    // Import here to avoid circular dependency at module load time
    const { pool } = await import('./db.js');
    try {
        await pool.query('REFRESH MATERIALIZED VIEW ah_price_hourly');
        console.log('[poller] Materialized view refreshed');
    } catch (err) {
        // Non-fatal — stale chart data is better than a crashed poller
        console.warn('[poller] Could not refresh materialized view:', err.message);
    }
}
