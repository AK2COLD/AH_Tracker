/**
 * db.js — PostgreSQL connection pool and query helpers
 *
 * All database access in this app goes through this module.
 * This makes it easy to swap the underlying driver later,
 * and ensures we never have raw SQL scattered across multiple files.
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// A pool keeps multiple connections open and ready, avoiding the overhead
// of opening a new TCP connection to Postgres on every query.
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Max connections — keep low for a personal app on a single machine
    max: 10,
    // How long to wait for a connection from the pool before erroring
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    // Log unexpected idle-client errors without crashing the whole process
    console.error('[db] Unexpected pool error:', err.message);
});

/**
 * Bulk-inserts auction snapshots in chunks of 1000 rows per statement.
 *
 * Why chunking? PostgreSQL allows a maximum of 65,535 bind parameters per
 * query. With 5 columns per row, that's a hard ceiling of ~13,107 rows per
 * INSERT. We use 1,000 to stay well clear and keep memory usage reasonable.
 *
 * Why a transaction? If the second chunk fails, we don't want the first
 * chunk committed — that would give us a partial, misleading snapshot.
 *
 * @param {Array<{item_id, buyout, quantity, time_left, scanned_at}>} rows
 */
export async function bulkInsertSnapshots(rows) {
    if (!rows.length) return;

    const CHUNK_SIZE = 1000;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            const chunk = rows.slice(i, i + CHUNK_SIZE);
            const { text, values } = buildInsertQuery(chunk);
            await client.query(text, values);
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;  // Re-throw so the poller can log it
    } finally {
        // Always release the client back to the pool, even if we error
        client.release();
    }
}

/**
 * Builds a single parameterized INSERT for an array of snapshot rows.
 * Returns { text, values } ready to pass directly to client.query().
 *
 * Parameterized queries ($1, $2, ...) are how you prevent SQL injection.
 * Never build SQL by concatenating user-controlled strings.
 */
function buildInsertQuery(rows) {
    const values = [];
    const rowPlaceholders = rows.map((row, i) => {
        const base = i * 5;
        values.push(row.item_id, row.buyout, row.quantity, row.time_left, row.scanned_at);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    const text = `
        INSERT INTO ah_snapshots (item_id, buyout, quantity, time_left, scanned_at)
        VALUES ${rowPlaceholders.join(', ')}
    `;

    return { text, values };
}

/**
 * Upserts item name/quality into the items table.
 * ON CONFLICT DO NOTHING means we don't overwrite existing data,
 * and we don't error if the item already exists.
 */
export async function upsertItem(itemId, name, quality) {
    await pool.query(
        `INSERT INTO items (item_id, name, quality)
         VALUES ($1, $2, $3)
         ON CONFLICT (item_id) DO NOTHING`,
        [itemId, name, quality]
    );
}
