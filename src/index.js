/**
 * index.js — Application entry point
 *
 * Wires together the three main pieces:
 *   1. Express HTTP server (serves the dashboard + REST API)
 *   2. Auction house poller (immediate + scheduled every 60s)
 *
 * Load order matters: dotenv must be imported first so all other modules
 * can safely read from process.env when they initialize.
 */

import 'dotenv/config';
import cron from 'node-cron';
import { createApp } from './api.js';
import { pollAuctions } from './poller.js';
import { startImporter } from './importer.js';

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10);

// Start the Express server
const app = createApp();
app.listen(PORT, () => {
    console.log(`[server] AH Tracker running at http://localhost:${PORT}`);
    console.log(`[server] Dashboard: http://localhost:${PORT}`);
    console.log(`[server] API base:  http://localhost:${PORT}/api`);
});

// Start the Auctionator SavedVariables importer (polls file for changes)
startImporter();

// Run the first poll immediately on startup so we don't wait 60s for data
console.log('[poller] Running initial poll...');
pollAuctions();

// Schedule subsequent polls using node-cron.
// The cron expression "*/60 * * * * *" means "every 60 seconds".
// We build it dynamically from POLL_INTERVAL_SECONDS so you can tune it in .env.
//
// Gotcha: node-cron's 6-field format (with seconds) requires a value <= 59.
// For intervals > 59s you'd need a different strategy, but 60s = "every minute"
// which maps cleanly to the cron expression "* * * * *".
const cronExpression = POLL_INTERVAL_SECONDS >= 60
    ? '* * * * *'           // Every minute
    : `*/${POLL_INTERVAL_SECONDS} * * * * *`;  // Every N seconds (6-field cron)

cron.schedule(cronExpression, () => {
    pollAuctions();
});

console.log(`[poller] Scheduled to poll every ${POLL_INTERVAL_SECONDS}s (cron: "${cronExpression}")`);
