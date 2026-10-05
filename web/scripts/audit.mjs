#!/usr/bin/env node
// `npm audit --audit-level=high`, except for advisories listed in
// audit-allowlist.json until their `expires` date (YYYY-MM-DD, UTC). Any other
// high or critical advisory fails, and so does an audit that could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LEVELS = new Set(['high', 'critical']);
const allowlist = JSON.parse(readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

let out = '';
try {
  out = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = e.stdout || ''; // npm audit exits non-zero whenever it finds anything
}
let report;
try {
  report = JSON.parse(out);
} catch {
  report = {};
}
if (report.error || !report.metadata) {
  console.log(`::error::npm audit did not complete: ${JSON.stringify(report.error || out.slice(0, 300))}`);
  process.exit(1);
}

const found = new Map();
for (const [pkg, vuln] of Object.entries(report.vulnerabilities || {})) {
  for (const via of vuln.via || []) {
    if (typeof via !== 'object' || !LEVELS.has(via.severity)) continue;
    const id = String(via.url || via.source).split('/').pop();
    const advisory = found.get(id) || { title: via.title, severity: via.severity, packages: new Set() };
    advisory.packages.add(pkg);
    found.set(id, advisory);
  }
}

let failed = false;
for (const [id, a] of found) {
  const entry = allowlist.find((x) => x.id === id);
  const where = [...a.packages].join(', ');
  if (entry && entry.expires >= today) {
    console.log(`::warning::${id} (${a.severity}) allowed until ${entry.expires}: ${a.title} [${where}]. ${entry.reason}`);
  } else {
    failed = true;
    const why = entry ? ` (allowlist entry expired ${entry.expires})` : '';
    console.log(`::error::${id} (${a.severity}) ${a.title} [${where}]${why}`);
  }
}
for (const entry of allowlist) {
  if (!found.has(entry.id)) console.log(`::notice::${entry.id} is no longer reported: remove it from audit-allowlist.json`);
}
console.log(failed ? 'audit: failed' : `audit: ok (${found.size} high/critical advisories, all allowlisted)`);
process.exit(failed ? 1 : 0);
