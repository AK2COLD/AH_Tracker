/**
 * logger.js — structured JSONL logging
 *
 * Writes newline-delimited JSON to logs/app.log.
 * Keeps an in-memory circular buffer of the last 200 events for /api/health queries.
 * Rotates the file at 5 MB.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR   = path.join(__dirname, '..', 'logs');
const LOG_FILE  = path.join(LOG_DIR, 'app.log');
const MAX_BYTES = 5 * 1024 * 1024;  // 5 MB
const BUFFER_SIZE = 200;

const buffer = [];

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
    try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size >= MAX_BYTES) {
            fs.renameSync(LOG_FILE, LOG_FILE + '.1');
        }
    } catch {}
}

function write(level, source, message, extra = {}) {
    const entry = { ts: new Date().toISOString(), level, source, message, ...extra };
    buffer.push(entry);
    if (buffer.length > BUFFER_SIZE) buffer.shift();

    try {
        ensureLogDir();
        rotateIfNeeded();
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    } catch {}
}

export const log = {
    info:  (source, message, data = {}) => write('info',  source, message, data),
    warn:  (source, message, data = {}) => write('warn',  source, message, data),
    error: (source, message, errOrData = {}, data = {}) => {
        const extra = errOrData instanceof Error
            ? { error: errOrData.message, stack: errOrData.stack, ...data }
            : { ...errOrData, ...data };
        write('error', source, message, extra);
    },
};

/**
 * Returns recent log entries, optionally filtered by level and/or since a Date.
 */
export function getRecentEvents({ since, level } = {}) {
    return buffer.filter(e => {
        if (since && new Date(e.ts) < since) return false;
        if (level  && e.level !== level)      return false;
        return true;
    });
}
