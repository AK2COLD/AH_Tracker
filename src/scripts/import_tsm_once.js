/**
 * import_tsm_once.js — Standalone TSM AppData importer
 *
 * Reads TSM AppData.lua once, writes market context to the database, and exits.
 * Designed to be called by Windows Task Scheduler every 30 minutes so that
 * price history and market intelligence accumulate even when the web app
 * is not running.
 *
 * Usage:
 *   node src/scripts/import_tsm_once.js
 *
 * Scheduled via Windows Task Scheduler (see scripts/setup_scheduler.ps1).
 */

import 'dotenv/config';
import { importTsmData } from '../tsm_importer.js';
import { pool } from '../db.js';

const start = Date.now();
console.log(`[tsm-once] Starting import at ${new Date().toISOString()}`);

try {
    await importTsmData();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[tsm-once] Done in ${elapsed}s`);
} catch (err) {
    console.error('[tsm-once] Import failed:', err.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
