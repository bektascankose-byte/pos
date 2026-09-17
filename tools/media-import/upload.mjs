/**
 * Put the manufacturers' photos on the catalogue, through the ordinary API.
 *
 * Nothing here writes to the database. It signs in as the owner and posts the
 * same multipart the back office posts, so every row lands with an audit entry
 * naming who uploaded it, and the bytes go to object storage the same way.
 */
import { readFile } from 'node:fs/promises';

const API = 'http://localhost:3000';
const EMAIL = 'owner@hhsmoke.test';
const PASSWORD = 'dev-password-change-me';

const login = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (login.status !== 201) {
  console.error('login failed', login.status, await login.text());
  process.exit(1);
}
const token = (await login.json()).access_token;
console.log('signed in as owner');

const manifest = JSON.parse(await readFile(new URL('./upload.json', import.meta.url), 'utf8'));
let ok = 0;
const failures = [];

for (const [i, item] of manifest.entries()) {
  const form = new FormData();
  const display = await readFile(new URL(`./out/${item.display}`, import.meta.url));
  const thumb = await readFile(new URL(`./out/${item.thumb}`, import.meta.url));
  form.set('file', new Blob([display], { type: 'image/jpeg' }), 'display.jpg');
  form.set('thumb', new Blob([thumb], { type: 'image/jpeg' }), 'thumb.jpg');
  if (item.product_id) form.set('product_id', item.product_id);
  if (item.variant_id) form.set('variant_id', item.variant_id);
  form.set('alt_text', item.alt_text);

  const res = await fetch(`${API}/api/v1/catalog/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (res.status === 201 || res.status === 200) {
    ok += 1;
    process.stdout.write(`\r  uploaded ${ok}/${manifest.length}`);
  } else {
    failures.push({ i, alt: item.alt_text, status: res.status, body: (await res.text()).slice(0, 300) });
  }
}

console.log(`\n${ok} uploaded, ${failures.length} failed`);
for (const f of failures.slice(0, 8)) console.log('  FAIL', f.status, f.alt, f.body);
