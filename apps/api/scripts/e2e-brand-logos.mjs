/**
 * Brand logos: stored as our own copy, served to the registers, and pulled by
 * them without waiting for a Send.
 *
 * The AI finder is not exercised here -- it searches the web and would make
 * the suite depend on somebody else's site being up. Everything after the
 * bytes are in hand is the same code path as an upload, which is.
 *
 * Imported by e2e.mjs, sharing its server and its reset.
 */

/** A one pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export async function runBrandLogoChecks({ api, base, check, ownerToken, cashierToken, storeId }) {
  const upload = async (brandId, token, bytes = PNG, type = 'image/png', source = null) => {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type }), type === 'image/png' ? 'logo.png' : 'logo.txt');
    if (source) form.set('source_url', source);
    const response = await fetch(`${base}/api/v1/catalog/brands/${brandId}/logo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const readLogo = (logoId, token) =>
    fetch(`${base}/api/v1/catalog/brand-logos/${logoId}`, { headers: { authorization: `Bearer ${token}` } });

  const brands = await api('/api/v1/catalog/brand-logos', { token: ownerToken });
  const brand = brands.body?.find((b) => b.name === 'Geek Bar') ?? brands.body?.[0];
  check('the brands page lists brands A to Z with no logo yet', brands.status === 200 && brand?.logo_id === null,
        JSON.stringify(brands.body?.map((b) => [b.name, b.logo_id])));

  const before = await api(`/api/v1/sync/catalog?store_id=${storeId}`, { token: cashierToken });
  const cursor = before.body?.cursor;

  const first = await upload(brand.id, ownerToken, PNG, 'image/png', 'https://www.example.com/brand');
  check('a logo can be uploaded for a brand', first.status === 201 && typeof first.body?.logo?.id === 'string',
        JSON.stringify(first));
  const logoId = first.body?.logo?.id;

  const listedWithLogo = (await api('/api/v1/catalog/brand-logos', { token: ownerToken })).body
    ?.find((b) => b.id === brand.id);
  check(
    'a found logo keeps the page it came from on record',
    listedWithLogo?.logo_id === logoId && listedWithLogo?.logo_source_url === 'https://www.example.com/brand',
    JSON.stringify(listedWithLogo),
  );

  const served = await readLogo(logoId, cashierToken);
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check(
    'a register can read the logo, as the same bytes, cacheable for good',
    served.status === 200 && served.headers.get('content-type') === 'image/png' && servedBytes.equals(PNG) &&
      (served.headers.get('cache-control') ?? '').includes('immutable'),
    `${served.status} ${served.headers.get('content-type')}`,
  );

  const after = await api(`/api/v1/sync/catalog?store_id=${storeId}&since=${cursor}`, { token: cashierToken });
  const synced = after.body?.brands?.find((b) => b.id === brand.id);
  check(
    'a new logo makes the registers pull the catalog without a Send, and names its address',
    after.status === 200 && after.body?.included_scopes?.includes('catalog') &&
      synced?.logo_url === `/api/v1/catalog/brand-logos/${logoId}`,
    JSON.stringify({ scopes: after.body?.included_scopes, synced }),
  );

  const cashierUpload = await upload(brand.id, cashierToken);
  check('a cashier cannot change a brand logo', cashierUpload.status === 403, `got ${cashierUpload.status}`);

  const notImage = await upload(brand.id, ownerToken, Buffer.from('not a picture'), 'text/plain');
  check('a file that is not a PNG, JPEG or WebP is refused', notImage.status === 400, `got ${notImage.status}`);

  const second = await upload(brand.id, ownerToken);
  const oldGone = await readLogo(logoId, ownerToken);
  check(
    'replacing a logo gives it a new address and retires the old one',
    second.status === 201 && second.body?.logo?.id !== logoId && oldGone.status === 404,
    JSON.stringify({ second: second.body, old: oldGone.status }),
  );

  const removed = await api(`/api/v1/catalog/brands/${brand.id}/logo`, { token: ownerToken, method: 'DELETE' });
  const removedAgain = await api(`/api/v1/catalog/brands/${brand.id}/logo`, { token: ownerToken, method: 'DELETE' });
  const listed = await api('/api/v1/catalog/brand-logos', { token: ownerToken });
  check(
    'removing a logo leaves the brand without one, and removing it twice is a clean 404',
    removed.status === 200 && removedAgain.status === 404 &&
      listed.body?.find((b) => b.id === brand.id)?.logo_id === null,
    JSON.stringify({ removed: removed.status, again: removedAgain.status }),
  );
}
