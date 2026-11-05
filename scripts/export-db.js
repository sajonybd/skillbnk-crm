// Makes one clean, single-file copy of the database to upload to a server: node scripts/export-db.js
// (VACUUM INTO folds in the -wal file, so nothing is lost even while the app is running.)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, DATA_DIR } from '../server/config.js';

// Written to data/export/, not the data root, so running the app on this computer never swaps it in by accident.
fs.mkdirSync(path.join(DATA_DIR, 'export'), { recursive: true });
const out = path.join(DATA_DIR, 'export', 'import.db');
fs.rmSync(out, { force: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`Wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB). Upload it to /var/data/import.db on the server; see DEPLOY.md.`);
