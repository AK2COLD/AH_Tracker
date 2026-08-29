import 'dotenv/config';
import fs from 'fs';
import { pool } from '../db.js';

const migrations = [
    'migrations/009_production_log.sql',
    'migrations/010_gold_snapshots.sql',
    'migrations/011_scan_unique.sql',
];

for (const file of migrations) {
    try {
        const sql = fs.readFileSync(file, 'utf8');
        await pool.query(sql);
        console.log(`[migrate] OK: ${file}`);
    } catch (err) {
        console.error(`[migrate] FAILED ${file}:`, err.message);
    }
}
await pool.end();
