/**
 * Price groups, the way the shop uses them.
 *
 * A drink line gets a group holding every flavor when its AI draft is saved.
 * One slow flavor also goes into a promotion group beside an item from a
 * different product, the promotion is priced, and only its members move. Then
 * the line is repriced and the slow flavor follows it, because a flavor's
 * price is whatever was set last. Nothing here touches the seeded Geek Bar
 * items the other checks count and price.
 *
 * Imported by e2e.mjs, sharing its server and its reset.
 */

export async function runPriceGroupChecks({ api, check, ownerToken, cashierToken, storeId }) {
  const createProduct = (body) =>
    api(`/api/v1/catalog/products?store_id=${storeId}`, { token: ownerToken, method: 'POST', body });

  const line = await createProduct({
    name: 'E2E Sparkling 12oz',
    variant_axes: ['flavor'],
    variants: [
      { sku: 'E2E-SPARK-ORANGE', variant_name: 'Orange', price_minor: '299' },
      { sku: 'E2E-SPARK-CHERRY', variant_name: 'Green Apple Cherry', price_minor: '299' },
      { sku: 'E2E-SPARK-MANGO', variant_name: 'Mango', price_minor: '349' },
      { sku: 'E2E-SPARK-PEACH', variant_name: 'Peach', price_minor: '299' },
    ],
  });
  check('a four flavor drink line is created', line.status === 201, JSON.stringify(line.body));
  const lineId = line.body?.id;

  const water = await createProduct({
    name: 'E2E Water 20oz',
    variants: [{ sku: 'E2E-WATER-20', price_minor: '349' }],
  });
  const waterId = water.body?.id;

  const variantsOf = async (productId) => {
    const r = await api(`/api/v1/catalog/products/${productId}`, { token: ownerToken });
    return Object.fromEntries((r.body?.variants ?? []).map((v) => [v.sku, v.id]));
  };
  const lineVariants = await variantsOf(lineId);
  const waterVariantId = (await variantsOf(waterId))['E2E-WATER-20'];
  const cherryId = lineVariants['E2E-SPARK-CHERRY'];

  const groupOf = async (groupId) => {
    const r = await api(`/api/v1/catalog/price-categories/${groupId}?store_id=${storeId}`, { token: ownerToken });
    return r.body;
  };
  const priceOf = (group, variantId) => group?.members?.find((m) => m.variant_id === variantId)?.price_minor;

  // ------------------------------------------------ the line's own group

  const made = await api(`/api/v1/catalog/products/${lineId}/price-group`, { token: ownerToken, method: 'POST' });
  check(
    'saving a drafted line makes a price group named for it, holding every flavor',
    made.status === 200 && made.body?.created === true && made.body?.added === 4 &&
      made.body?.price_group?.name === 'E2E Sparkling 12oz',
    JSON.stringify(made.body),
  );
  const lineGroupId = made.body?.price_group?.id;

  let lineGroup = await groupOf(lineGroupId);
  check(
    'making the group changes no price: the flavors keep the prices they had',
    priceOf(lineGroup, cherryId) === '299' && priceOf(lineGroup, lineVariants['E2E-SPARK-MANGO']) === '349' &&
      lineGroup?.current_price_minor === null,
    JSON.stringify(lineGroup?.members?.map((m) => [m.sku, m.price_minor])),
  );

  const again = await api(`/api/v1/catalog/products/${lineId}/price-group`, { token: ownerToken, method: 'POST' });
  check(
    'drafting the line again finds the same group instead of making a second',
    again.body?.price_group?.id === lineGroupId && again.body?.created === false,
    JSON.stringify(again.body),
  );

  const lime = await api(`/api/v1/catalog/products/${lineId}/variants`, {
    token: ownerToken,
    method: 'POST',
    body: { sku: 'E2E-SPARK-LIME', variant_name: 'Lime' },
  });
  lineGroup = await groupOf(lineGroupId);
  check(
    'a flavor added to the line later joins its group',
    lime.status === 201 && lineGroup?.member_count === 5 &&
      lineGroup?.members?.some((m) => m.sku === 'E2E-SPARK-LIME'),
    JSON.stringify(lineGroup?.members?.map((m) => m.sku)),
  );

  const single = await api(`/api/v1/catalog/products/${waterId}/price-group`, { token: ownerToken, method: 'POST' });
  check(
    'a one flavor item gets no group of its own',
    single.status === 200 && single.body?.price_group === null,
    JSON.stringify(single.body),
  );

  // ------------------------------------------------ a promotion across products

  const promo = await api('/api/v1/catalog/price-categories', {
    token: ownerToken,
    method: 'POST',
    body: { name: 'E2E Slow movers' },
  });
  const promoId = promo.body?.id;
  const joined = await api(`/api/v1/catalog/price-categories/${promoId}/members`, {
    token: ownerToken,
    method: 'POST',
    body: { variant_ids: [cherryId, waterVariantId] },
  });
  lineGroup = await groupOf(lineGroupId);
  check(
    'a flavor joins a promotion and stays in its own line group',
    joined.status === 201 && joined.body?.added === 2 && lineGroup?.member_count === 5 &&
      lineGroup?.members?.find((m) => m.variant_id === cherryId)?.also_in?.some((g) => g.id === promoId),
    JSON.stringify(joined.body),
  );

  const rejoin = await api(`/api/v1/catalog/price-categories/${promoId}/members`, {
    token: ownerToken,
    method: 'POST',
    body: { variant_ids: [cherryId] },
  });
  check('adding a member twice is not an error and adds nothing', rejoin.body?.added === 0 && rejoin.body?.already === 1,
        JSON.stringify(rejoin.body));

  const promoPriced = await api('/api/v1/catalog/variants/bulk-price', {
    token: ownerToken,
    method: 'POST',
    body: { price_minor: '199', price_group_id: promoId, store_id: storeId },
  });
  let promoGroup = await groupOf(promoId);
  lineGroup = await groupOf(lineGroupId);
  check(
    'pricing the promotion moves only its members',
    promoPriced.status === 201 && promoGroup?.current_price_minor === '199' &&
      priceOf(lineGroup, cherryId) === '199' &&
      priceOf(lineGroup, lineVariants['E2E-SPARK-ORANGE']) === '299' &&
      priceOf(lineGroup, lineVariants['E2E-SPARK-MANGO']) === '349',
    JSON.stringify({ status: promoPriced.status, line: lineGroup?.members?.map((m) => [m.sku, m.price_minor]) }),
  );

  const list = await api(`/api/v1/catalog/price-categories?store_id=${storeId}`, { token: ownerToken });
  const listedLine = list.body?.find((g) => g.id === lineGroupId);
  check(
    'the line group reports its usual price and how many flavors are off it',
    listedLine?.common_price_minor === '299' && listedLine?.current_price_minor === null &&
      listedLine?.mismatch_count === 3 && listedLine?.product_id === lineId,
    JSON.stringify(listedLine),
  );

  const linePriced = await api('/api/v1/catalog/variants/bulk-price', {
    token: ownerToken,
    method: 'POST',
    body: { price_minor: '329', price_group_id: lineGroupId, store_id: storeId },
  });
  lineGroup = await groupOf(lineGroupId);
  promoGroup = await groupOf(promoId);
  check(
    'repricing the line later moves every flavor, the promoted one included: the latest price wins',
    linePriced.status === 201 && lineGroup?.current_price_minor === '329' &&
      priceOf(promoGroup, cherryId) === '329' && priceOf(promoGroup, waterVariantId) === '199',
    JSON.stringify(promoGroup?.members?.map((m) => [m.sku, m.price_minor])),
  );

  const sameSet = await api('/api/v1/catalog/variants/bulk-price', {
    token: ownerToken,
    method: 'POST',
    body: { price_minor: '329', variant_ids: lineGroup?.members?.map((m) => m.variant_id), store_id: storeId },
  });
  check(
    'pricing exactly a group\'s flavors together reuses that group instead of making another',
    sameSet.status === 201 && sameSet.body?.price_group_id === lineGroupId,
    JSON.stringify(sameSet.body?.price_group_id),
  );

  await api('/api/v1/catalog/variants/bulk-price', {
    token: ownerToken,
    method: 'POST',
    body: { price_minor: '149', price_group_id: promoId, store_id: storeId },
  });
  lineGroup = await groupOf(lineGroupId);
  check(
    'and pricing the promotion again takes the flavor back down, alone',
    priceOf(lineGroup, cherryId) === '149' && priceOf(lineGroup, lineVariants['E2E-SPARK-ORANGE']) === '329',
    JSON.stringify(lineGroup?.members?.map((m) => [m.sku, m.price_minor])),
  );

  const search = await api(`/api/v1/catalog/products?q=E2E%20Sparkling&store_id=${storeId}`, { token: ownerToken });
  const cherryRow = search.body?.data?.find((r) => r.variant_id === cherryId);
  check(
    'the catalog list names every group a flavor is in',
    cherryRow?.price_groups?.length === 2 &&
      cherryRow.price_groups.some((g) => g.id === lineGroupId) && cherryRow.price_groups.some((g) => g.id === promoId),
    JSON.stringify(cherryRow?.price_groups),
  );

  const scanned = await api(`/api/v1/catalog/price-categories/${promoId}/scan`, {
    token: ownerToken,
    method: 'POST',
    body: { code: 'E2E-SPARK-MANGO', store_id: storeId },
  });
  check(
    'a scanned item joins with its current price, and says whether it was already in',
    scanned.status === 201 && scanned.body?.price_minor === '329' && scanned.body?.already_member === false,
    JSON.stringify(scanned.body),
  );

  // ------------------------------------------------ leaving and dissolving

  const left = await api(`/api/v1/catalog/price-categories/${promoId}/members/${cherryId}/remove`, {
    token: ownerToken,
    method: 'POST',
  });
  lineGroup = await groupOf(lineGroupId);
  check(
    'leaving the promotion leaves the flavor in its line group at the price it has',
    left.status === 201 && lineGroup?.members?.some((m) => m.variant_id === cherryId) &&
      priceOf(lineGroup, cherryId) === '149',
    JSON.stringify(left.body),
  );

  const cashierMake = await api('/api/v1/catalog/price-categories', {
    token: cashierToken,
    method: 'POST',
    body: { name: 'Not allowed' },
  });
  check('a cashier cannot make a price group', cashierMake.status === 403, `got ${cashierMake.status}`);

  const dissolved = await api(`/api/v1/catalog/price-categories/${promoId}`, { token: ownerToken, method: 'DELETE' });
  const waterRow = (await api(`/api/v1/catalog/products?q=E2E%20Water&store_id=${storeId}`, { token: ownerToken }))
    .body?.data?.[0];
  lineGroup = await groupOf(lineGroupId);
  check(
    'deleting the promotion releases its items at their prices and leaves the line group whole',
    dissolved.body?.released === 2 && waterRow?.price_minor === '149' && waterRow?.price_groups?.length === 0 &&
      lineGroup?.member_count === 5,
    JSON.stringify({ dissolved: dissolved.body, water: waterRow }),
  );
}
