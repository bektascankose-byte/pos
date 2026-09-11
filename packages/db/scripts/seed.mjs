#!/usr/bin/env node
// Development seed: one organization, one store, two registers and a small but
// realistic smoke shop catalog.
//
// Realistic matters. A catalog of "Product 1 / Product 2" hides the problems
// this system exists to solve: a four flavor vape that is one product with four
// independently stocked variants, a nicotine SKU that must prompt for ID, and a
// drink that must not. Every later phase develops against this data.
//
// Safe to re-run: it deletes the seed organization first. It refuses to run
// against a database that holds sales.

import pg from 'pg';
import { hash } from '@node-rs/argon2';
import { DEFAULT_URL } from '../src/engine.mjs';

const ORG_SLUG = 'hh-smoke';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? DEFAULT_URL });
await client.connect();

const q = async (sql, params) => (await client.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

const [{ n: saleCount }] = await q('select count(*)::int n from sales');
if (saleCount > 0 && !process.argv.includes('--force')) {
  console.error(
    `\n  refusing to seed: this database holds ${saleCount} sales.\n` +
      `  Use --force only if you are certain.\n`,
  );
  process.exit(1);
}

await client.query('BEGIN');

// Re-runnable, but not by deleting the organization and letting cascades sort
// it out: almost every foreign key to organizations is ON DELETE RESTRICT, on
// purpose, so that nobody can remove a business and take its financial history
// with it. The seed therefore clears its own tables in dependency order.
//
// Anything the seed does not own is left alone and will block the delete, which
// is the correct outcome: if this database has grown sales or purchase orders,
// re-seeding is not what anyone wanted. Use `npm run db:reset` for a clean slate.
const existing = await one('select id from organizations where slug = $1', [ORG_SLUG]);
if (existing) {
  const orderedTables = [
    'inventory_ledger',
    'inventory_levels',
    'variant_prices',
    'variant_barcodes',
    'product_variants',
    'product_compliance',
    'products',
    'brands',
    'categories',
    'tax_rates',
    'tax_categories',
    'employee_pins',
    'user_roles',
    'auth_sessions',
    'users',
    'registers',
    'stores',
  ];
  for (const table of orderedTables) {
    await client.query(`delete from ${table} where org_id = $1`, [existing.id]);
  }
  await client.query('delete from organizations where id = $1', [existing.id]);
}

const org = await one(
  `insert into organizations (slug, legal_name, display_name)
   values ($1, 'Harker Heights Smoke & Vape LLC', 'HH Smoke & Vape') returning id`,
  [ORG_SLUG],
);

const store = await one(
  `insert into stores (org_id, code, name, region, city, county, timezone)
   values ($1, 'HH01', 'Harker Heights', 'TX', 'Harker Heights', 'Bell', 'America/Chicago')
   returning id`,
  [org.id],
);

for (const [code, name] of [
  ['R1', 'Front Counter'],
  ['R2', 'Second Register'],
]) {
  await client.query(
    `insert into registers (org_id, store_id, code, name) values ($1,$2,$3,$4)`,
    [org.id, store.id, code, name],
  );
}

// ----------------------------------------------------------------------- staff
// Development credentials only. Printed at the end so nobody has to grep for
// them, and refused outright if NODE_ENV is production.
if (process.env.NODE_ENV === 'production') {
  console.error('\n  refusing to seed known passwords into a production database\n');
  process.exit(1);
}

const DEV_PASSWORD = 'dev-password-change-me';
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const ARGON_PIN = { memoryCost: 4096, timeCost: 2, parallelism: 1 };

const passwordHash = await hash(DEV_PASSWORD, ARGON);

const staff = [];
for (const [roleKey, email, fullName, pin] of [
  ['owner', 'owner@hhsmoke.test', 'Sam Okafor', '1234'],
  ['manager', 'manager@hhsmoke.test', 'Dana Reyes', '2345'],
  ['cashier', 'cashier@hhsmoke.test', 'Maria Chen', '3456'],
]) {
  const u = await one(
    `insert into users (org_id, email, full_name, display_name, password_hash, status)
     values ($1,$2,$3,$4,$5,'active') returning id`,
    [org.id, email, fullName, fullName.split(' ')[0], passwordHash],
  );

  // Platform roles have a NULL org_id and are shared by every organization.
  const role = await one(`select id from roles where org_id is null and key = $1`, [roleKey]);
  await client.query(
    `insert into user_roles (org_id, user_id, role_id, store_id) values ($1,$2,$3,$4)`,
    [org.id, u.id, role.id, store.id],
  );

  await client.query(
    `insert into employee_pins (user_id, org_id, pin_hash) values ($1,$2,$3)`,
    [u.id, org.id, await hash(pin, ARGON_PIN)],
  );

  staff.push({ email, roleKey, pin });
}

// -------------------------------------------------------------------- taxonomy
const brandIds = {};
for (const name of ['Geek Bar', 'Lost Mary', 'Backwoods', 'Zyn', 'Monster', 'RAW']) {
  const row = await one(
    `insert into brands (org_id, name) values ($1,$2) returning id`,
    [org.id, name],
  );
  brandIds[name] = row.id;
}

// Materialized path, maintained by the application. Depth and path are derived
// from the parent, which is the rule the API layer will own.
const catIds = {};
async function category(slug, name, parentPath = null, isDepartment = false) {
  const parent = parentPath ? catIds[parentPath] : null;
  const path = parent ? `${parent.path}.${slug}` : slug;
  const row = await one(
    `insert into categories (org_id, parent_id, slug, name, path, depth, is_department)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      org.id,
      parent ? parent.id : null,
      slug,
      name,
      path,
      path.split('.').length - 1,
      isDepartment,
    ],
  );
  catIds[path] = { id: row.id, path };
  return catIds[path];
}

await category('vapes', 'Vapes', null, true);
await category('disposable', 'Disposable Vapes', 'vapes');
await category('tobacco', 'Tobacco', null, true);
await category('cigars', 'Cigars & Wraps', 'tobacco');
await category('nicotine-pouches', 'Nicotine Pouches', 'tobacco');
await category('accessories', 'Accessories', null, true);
await category('papers', 'Rolling Papers', 'accessories');
await category('drinks', 'Drinks', null, true);

// Tax categories and rates are per organization, effective dated, and never a
// hard coded percentage. Texas state sales tax is 6.25% with local add ons;
// Harker Heights totals 8.25%. These are development values, not tax advice:
// real rates are configured per store before go live.
const taxCategories = {};
for (const [code, name] of [
  ['standard', 'Standard Rate'],
  ['exempt', 'Tax Exempt'],
]) {
  const row = await one(
    `insert into tax_categories (org_id, code, name) values ($1,$2,$3) returning id`,
    [org.id, code, name],
  );
  taxCategories[code] = row.id;
}

await client.query(
  `insert into tax_rates (org_id, store_id, tax_category_id, name, rate)
   values ($1,$2,$3,'TX State + Local Sales Tax',0.082500)`,
  [org.id, store.id, taxCategories.standard],
);

const defaultTaxCategory = taxCategories.standard;

// -------------------------------------------------------------------- products
async function product({ name, brand, category: categoryPath, variants, compliance }) {
  const p = await one(
    `insert into products (org_id, name, brand_id, category_id, tax_category_id,
                           has_variants, variant_axes, status)
     values ($1,$2,$3,$4,$5,$6,$7,'active') returning id`,
    [
      org.id,
      name,
      brandIds[brand] ?? null,
      catIds[categoryPath].id,
      defaultTaxCategory,
      variants.length > 1,
      variants.length > 1 ? ['flavor'] : [],
    ],
  );

  if (compliance) {
    await client.query(
      `insert into product_compliance (org_id, product_id, minimum_age, id_scan_required,
                                       regulated_class, contains_nicotine, is_smokable)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        org.id,
        p.id,
        compliance.minimum_age,
        compliance.id_scan_required ?? true,
        compliance.regulated_class ?? null,
        compliance.contains_nicotine ?? false,
        compliance.is_smokable ?? false,
      ],
    );
  }

  for (const [i, v] of variants.entries()) {
    const variant = await one(
      `insert into product_variants (org_id, product_id, sku, variant_name, attributes,
                                     is_default, sort_order, cost, average_cost, case_quantity)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) returning id`,
      [
        org.id,
        p.id,
        v.sku,
        v.flavor ?? null,
        v.flavor ? JSON.stringify({ flavor: v.flavor }) : '{}',
        i === 0,
        i,
        v.cost,
        v.caseQty ?? 1,
      ],
    );

    await client.query(
      `insert into variant_barcodes (org_id, variant_id, barcode, kind, is_primary)
       values ($1,$2,$3,'upc',true)`,
      [org.id, variant.id, v.upc],
    );

    await client.query(
      `insert into variant_prices (org_id, variant_id, store_id, kind, price_minor)
       values ($1,$2,$3,'regular',$4)`,
      [org.id, variant.id, store.id, v.priceMinor],
    );

    // Opening stock goes through the ledger, never straight into a level.
    // There is no other way to create inventory in this system and the seed
    // must not be the exception that teaches otherwise.
    //
    // A zero opening balance gets no ledger row: ledger_delta_nonzero rejects
    // it, correctly, because nothing moved. The level row below still exists at
    // zero, which is the difference between "we stock this and have none" and
    // "we do not stock this".
    if (v.qty !== 0) {
      await client.query(
        `insert into inventory_ledger (org_id, store_id, variant_id, delta, reason, unit_cost,
                                       reference_type, note)
         values ($1,$2,$3,$4,'opening_balance',$5,'seed','development seed data')`,
        [org.id, store.id, variant.id, v.qty, v.cost],
      );
    }
    await client.query(
      `insert into inventory_levels (org_id, store_id, variant_id, on_hand, reserved)
       values ($1,$2,$3,$4,0)
       on conflict (store_id, variant_id)
       do update set on_hand = inventory_levels.on_hand + excluded.on_hand`,
      [org.id, store.id, variant.id, v.qty],
    );
  }
  return p;
}

const ENDS = {
  minimum_age: 21,
  id_scan_required: true,
  contains_nicotine: true,
  regulated_class: 'ends',
  is_smokable: true,
};

await product({
  name: 'Geek Bar Pulse X',
  brand: 'Geek Bar',
  category: 'vapes.disposable',
  compliance: ENDS,
  variants: [
    { sku: 'GB-PULSEX-MM', flavor: 'Miami Mint', upc: '840216300101', cost: 9.85, priceMinor: 2499, qty: 12, caseQty: 5 },
    { sku: 'GB-PULSEX-BR', flavor: 'Blue Razz Ice', upc: '840216300118', cost: 9.85, priceMinor: 2499, qty: 18, caseQty: 5 },
    { sku: 'GB-PULSEX-SB', flavor: 'Strawberry Banana', upc: '840216300125', cost: 9.85, priceMinor: 2499, qty: 7, caseQty: 5 },
    // Deliberately zero: the register, the storefront and the reorder report
    // all need an out of stock variant to develop against on day one.
    { sku: 'GB-PULSEX-WI', flavor: 'Watermelon Ice', upc: '840216300132', cost: 9.85, priceMinor: 2499, qty: 0, caseQty: 5 },
  ],
});

await product({
  name: 'Lost Mary BM6000',
  brand: 'Lost Mary',
  category: 'vapes.disposable',
  compliance: ENDS,
  variants: [
    { sku: 'LM-BM6000-BB', flavor: 'Blueberry Ice', upc: '810082310014', cost: 7.9, priceMinor: 1999, qty: 22, caseQty: 10 },
    { sku: 'LM-BM6000-PM', flavor: 'Pineapple Mango', upc: '810082310021', cost: 7.9, priceMinor: 1999, qty: 9, caseQty: 10 },
  ],
});

await product({
  name: 'Backwoods Cigars 5pk',
  brand: 'Backwoods',
  category: 'tobacco.cigars',
  compliance: {
    minimum_age: 21,
    id_scan_required: true,
    contains_nicotine: true,
    is_smokable: true,
    regulated_class: 'cigar',
  },
  variants: [
    { sku: 'BW-HONEY-5', flavor: 'Honey Berry', upc: '027200003018', cost: 3.1, priceMinor: 649, qty: 40, caseQty: 8 },
    { sku: 'BW-ORIG-5', flavor: 'Original', upc: '027200003001', cost: 3.1, priceMinor: 649, qty: 35, caseQty: 8 },
  ],
});

await product({
  name: 'Zyn Nicotine Pouches',
  brand: 'Zyn',
  category: 'tobacco.nicotine-pouches',
  compliance: {
    minimum_age: 21,
    id_scan_required: true,
    contains_nicotine: true,
    regulated_class: 'pouch',
  },
  variants: [
    { sku: 'ZYN-COOL-6', flavor: 'Cool Mint 6mg', upc: '300060000016', cost: 3.45, priceMinor: 599, qty: 30, caseQty: 5 },
    { sku: 'ZYN-CITR-3', flavor: 'Citrus 3mg', upc: '300060000023', cost: 3.45, priceMinor: 599, qty: 25, caseQty: 5 },
  ],
});

// Not age restricted. The compliance engine must be able to say "no prompt" as
// confidently as it says "prompt", and a catalog of only regulated SKUs would
// never exercise that path.
await product({
  name: 'Monster Energy Ultra',
  brand: 'Monster',
  category: 'drinks',
  variants: [{ sku: 'MON-ULTRA-16', upc: '070847811169', cost: 1.55, priceMinor: 399, qty: 48, caseQty: 24 }],
});

await product({
  name: 'RAW Classic King Size Slim',
  brand: 'RAW',
  category: 'accessories.papers',
  variants: [{ sku: 'RAW-KSS', upc: '716165174233', cost: 1.1, priceMinor: 299, qty: 60, caseQty: 50 }],
});

await client.query('COMMIT');

const summary = await one(
  `select (select count(*) from products          where org_id=$1)::int products,
          (select count(*) from product_variants  where org_id=$1)::int variants,
          (select count(*) from variant_barcodes  where org_id=$1)::int barcodes,
          (select coalesce(sum(on_hand),0) from inventory_levels where org_id=$1)::int units`,
  [org.id],
);

console.log(`
  seeded ${ORG_SLUG}
    store      HH01 Harker Heights, registers R1 and R2
    products   ${summary.products}
    variants   ${summary.variants}
    barcodes   ${summary.barcodes}
    units      ${summary.units} on hand, all posted through the ledger

  development sign in (password is the same for all three)
    password   ${DEV_PASSWORD}
${staff.map((m) => `    ${m.roleKey.padEnd(10)} ${m.email.padEnd(26)} PIN ${m.pin}`).join(String.fromCharCode(10))}
`);

await client.end();
