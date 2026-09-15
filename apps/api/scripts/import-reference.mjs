#!/usr/bin/env node
// Load a legacy item file into the reference catalog.
//
//   node --experimental-strip-types scripts/import-reference.mjs <file.xlsx> [--source modisoft] [--dry-run]
//
// Reference rows are things the shop KNOWS ABOUT, not things it sells. Nothing
// here creates a product, a price or a stock movement -- see migration 0020 for
// why that separation exists. Promoting a row into the real catalog is a
// separate, deliberate act performed per item from the UI.
//
// Re-runnable: rows upsert on (org_id, source, scan_code), so re-importing a
// fresh export corrects what changed and leaves the rest alone.

import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
import { cleanProductName } from '../src/modules/catalog/product-name.ts';
import { normalizeCode } from '../src/modules/catalog/scan-code.ts';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const source = args[args.indexOf('--source') + 1] ?? 'modisoft';

if (!file) {
  console.error('usage: import-reference.mjs <file.xlsx> [--source name] [--dry-run]');
  process.exit(1);
}

// Header -> column. Named rather than positional: a later export with an extra
// column would otherwise silently load prices into the size field.
const COLUMNS = {
  scan_code: 'Scan Code',
  item_code: 'Item Code',
  description: 'Description',
  department: 'Department',
  size: 'Size',
  retail: 'Retail',
  cost: 'Cost',
  units_per_case: 'Units Per Case',
  quantity: 'Current Qty',
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.resolve(file));
const sheet = wb.worksheets[0];

const headers = [];
sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, i) => {
  headers[i] = text(cell.value).trim();
});

const missing = Object.values(COLUMNS).filter((h) => !headers.includes(h));
if (missing.length) {
  console.error(`this file is missing expected columns: ${missing.join(', ')}`);
  console.error(`found: ${headers.filter(Boolean).join(', ')}`);
  process.exit(1);
}

const at = Object.fromEntries(Object.entries(COLUMNS).map(([key, header]) => [key, headers.indexOf(header)]));

/** Excel cells arrive as strings, numbers, formula results or rich text. */
function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return text(value.result);
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value);
}

const num = (value) => {
  const raw = text(value).replace(/[$,\s]/g, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const rows = [];
const skipped = { noCode: 0, duplicate: 0 };
const seen = new Set();
let renamed = 0;
let unusable = 0;

sheet.eachRow((row, index) => {
  if (index === 1) return;

  const code = normalizeCode(text(row.getCell(at.scan_code).value));
  if (!code) {
    skipped.noCode += 1;
    return;
  }
  if (seen.has(code)) {
    // Last row wins, matching the upsert's own behaviour, so a file with
    // duplicates imports the same way twice.
    skipped.duplicate += 1;
  }
  seen.add(code);

  const original = text(row.getCell(at.description).value);
  const { name, unusable: bad } = cleanProductName(original);
  if (name !== original) renamed += 1;
  if (bad) unusable += 1;

  const retail = num(row.getCell(at.retail).value);
  const cost = num(row.getCell(at.cost).value);
  const perCase = num(row.getCell(at.units_per_case).value);
  const quantity = num(row.getCell(at.quantity).value);

  rows.push({
    scan_code: code,
    item_code: text(row.getCell(at.item_code).value).trim() || null,
    description: name || null,
    department: text(row.getCell(at.department).value).trim() || null,
    size: text(row.getCell(at.size).value).trim() || null,
    // Retail arrives as dollars and is stored in minor units, like every
    // other price in the system. Rounded, not truncated: a legacy 1.995
    // is 200c, and floor() would quietly shave a cent off thousands of rows.
    retail_minor: retail === null ? null : String(Math.round(retail * 100)),
    cost: cost === null ? null : String(cost),
    units_per_case: perCase === null ? null : Math.round(perCase),
    source_quantity: quantity === null ? null : String(quantity),
    // The untouched source row, so a cleaned name is never a lossy edit and
    // any column nobody thought to map can still be recovered.
    raw: Object.fromEntries(
      headers.map((header, i) => [header, text(row.getCell(i).value)]).filter(([header]) => header),
    ),
  });
});

console.log(
  `${path.basename(file)}: ${rows.length} rows ready ` +
    `(${renamed} names tidied, ${unusable} flagged as unusable, ` +
    `${skipped.noCode} skipped for no scan code, ${skipped.duplicate} duplicate codes)`,
);

if (dryRun) {
  console.log('\nfirst 10 as they would be stored:');
  for (const row of rows.slice(0, 10)) {
    console.log(`  ${row.scan_code.padEnd(16)} ${row.description ?? '(no name)'}`);
  }
  process.exit(0);
}

const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://snappos_migrator:dev_only_not_a_secret@localhost:5432/snappos',
});
await client.connect();

const { rows: orgs } = await client.query(
  'SELECT id, display_name FROM organizations ORDER BY created_at LIMIT 2',
);
if (orgs.length !== 1) {
  console.error(
    orgs.length === 0
      ? 'no organization in this database -- seed one first'
      : 'more than one organization: pass the right one explicitly rather than guessing',
  );
  process.exit(1);
}
const org = orgs[0];

await client.query('BEGIN');
// The import runs as the org, under the same row-level security every request
// does, rather than bypassing it because this happens to be a script.
await client.query(`SET LOCAL app.org_id = '${org.id}'`);

let written = 0;
for (const row of rows) {
  await client.query(
    `INSERT INTO reference_products
       (org_id, source, scan_code, item_code, description, department, size,
        retail_minor, cost, units_per_case, source_quantity, raw)
     VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (org_id, source, scan_code) DO UPDATE SET
       item_code       = EXCLUDED.item_code,
       description     = EXCLUDED.description,
       department      = EXCLUDED.department,
       size            = EXCLUDED.size,
       retail_minor    = EXCLUDED.retail_minor,
       cost            = EXCLUDED.cost,
       units_per_case  = EXCLUDED.units_per_case,
       source_quantity = EXCLUDED.source_quantity,
       raw             = EXCLUDED.raw`,
    [
      source,
      row.scan_code,
      row.item_code,
      row.description,
      row.department,
      row.size,
      row.retail_minor,
      row.cost,
      row.units_per_case,
      row.source_quantity,
      JSON.stringify(row.raw),
    ],
  );
  written += 1;
  if (written % 1000 === 0) process.stdout.write(`  ${written}/${rows.length}\r`);
}

await client.query('COMMIT');
console.log(`\nwrote ${written} reference rows to "${org.display_name}" under source "${source}"`);
await client.end();
