/**
 * Put the key visuals on the home page, and list the photographed items.
 *
 * Both through the ordinary API as the owner, so each lands with an audit
 * entry rather than appearing in the database from nowhere.
 */
import { readFile } from 'node:fs/promises';

const API = 'http://localhost:3000';
const STORE_ID = '01a0922c-46f3-7fb6-97f4-2cd58c2165fc';
const BRAND = { foger: '01a0aaa4-92cf-777c-b545-2f7e1beabdb6', geekbar: '01a0922c-4715-7ca3-acdf-a242cff95b38' };

const login = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner@hhsmoke.test', password: 'dev-password-change-me' }),
});
if (login.status !== 201) { console.error('login failed', login.status, await login.text()); process.exit(1); }
const token = (await login.json()).access_token;
const auth = { authorization: `Bearer ${token}` };

// ---------------------------------------------------------------- banners
const BANNERS = [
  { name: 'geekbar-pulse-x-hero', placement: 'home_hero',
    title: 'Geek Bar Pulse X key visual',
    headline: 'Geek Bar Pulse X',
    body: 'The 3D curved screen, in stock now. Order ahead and collect at the counter.',
    cta_label: 'Shop Geek Bar', link_kind: 'brand', link_value: BRAND.geekbar,
    alt_text: 'Geek Bar Pulse X device shown against a dark backdrop with its curved display lit.',
    source_note: "Manufacturer media kit: Geek Bar Pulse, key visual" },
  { name: 'foger-switchpro-feature', placement: 'home_feature',
    title: 'Foger SwitchPro banner',
    headline: 'Foger SwitchPro',
    body: 'Swappable pods across dozens of flavours.',
    cta_label: 'Shop Foger', link_kind: 'brand', link_value: BRAND.foger,
    alt_text: 'Foger SwitchPro pod device with a row of coloured flavour pods beside it.',
    source_note: 'Manufacturer media kit: Foger Switch Pro Pods, poster' },
  { name: 'geekbar-mate-feature', placement: 'home_feature',
    title: 'Geek Bar Mate 60K banner',
    headline: 'Geek Bar Mate 60K',
    body: 'Long-life device, ask at the counter.',
    cta_label: 'Shop Geek Bar', link_kind: 'brand', link_value: BRAND.geekbar,
    alt_text: 'Geek Bar Mate 60K device shown at an angle on a coloured background.',
    source_note: 'Manufacturer media kit: Geek Bar Mate 60K, key visual' },
];

const manifest = JSON.parse(await readFile(new URL('./banners.json', import.meta.url), 'utf8'));
const byName = new Map(manifest.map((m) => [m.name, m]));

for (const b of BANNERS) {
  const art = byName.get(b.name);
  if (!art) { console.log('no artwork for', b.name); continue; }
  const form = new FormData();
  for (const [k, v] of Object.entries(b)) if (k !== 'name') form.set(k, v);
  form.set('advertises_nicotine', 'true');
  form.set('hide_when_unavailable', 'false');
  form.set('store_id', STORE_ID);
  for (const [kind, file] of Object.entries(art.files)) {
    const bytes = await readFile(new URL(`./banners/${file.file}`, import.meta.url));
    form.set(kind, new Blob([bytes], { type: 'image/jpeg' }), file.file);
  }
  const res = await fetch(`${API}/api/v1/storefront/banners`, { method: 'POST', headers: auth, body: form });
  console.log(`banner ${b.name}: ${res.status}`, res.ok ? '' : (await res.text()).slice(0, 400));
}

// --------------------------------------------------------------- listings
const matched = JSON.parse(await readFile(new URL('./matched.json', import.meta.url), 'utf8'));
const variantIds = [...new Set(matched.map((m) => m.variant_id))];
let listed = 0;
const failed = [];
for (const variantId of variantIds) {
  const res = await fetch(`${API}/api/v1/storefront/listings/${variantId}?store_id=${STORE_ID}`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ availability: 'pickup_only' }),
  });
  if (res.ok) listed += 1;
  else failed.push({ variantId, status: res.status, body: (await res.text()).slice(0, 200) });
}
console.log(`listed ${listed}/${variantIds.length} for pickup`);
for (const f of failed.slice(0, 5)) console.log('  FAIL', f.status, f.body);
