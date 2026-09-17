import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  OrderFulfilment,
  ShopCategory,
  ShopInfo,
  ShopProductCard,
  ShopProductDetail,
  ShopProductList,
  ShopStock,
  ShopSuggestion,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { TransactionalMailer } from '../../platform/messaging/transactional-mailer.js';
import { PaymentsService } from '../../platform/payments/payments.service.js';
import type { ShopClient } from '../../platform/shop/shop-key.registry.js';
import { ComplianceService, type JurisdictionContext, type LineDecision } from '../compliance/compliance.service.js';
import { ProductImagesService } from '../catalog/product-images.service.js';
import { DeliverySettingsService } from '../delivery/delivery-settings.service.js';

/** One variant the website may show, with everything a page needs about it. */
export interface ListedVariant {
  variantId: string;
  productId: string;
  productName: string;
  description: string | null;
  brandId: string | null;
  brandName: string | null;
  categoryId: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  variantName: string | null;
  attributes: Record<string, string>;
  sortOrder: number;
  sku: string;
  barcodes: string[];
  priceMinor: string;
  sellable: number;
  maxPerOrder: number | null;
  variantImageId: string | null;
  productImageId: string | null;
  minimumAge: number | null;
  idRequired: boolean;
  productCreatedAt: Date;
}

interface Snapshot {
  at: number;
  variants: ListedVariant[];
}

export type ProductSort = 'featured' | 'price_asc' | 'price_desc' | 'newest' | 'name';

export interface ProductQuery {
  category?: string | undefined;
  brand?: string | undefined;
  q?: string | undefined;
  inStock?: boolean | undefined;
  sort?: ProductSort | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** What has something in stock online right now, for deciding which banners may show. */
export interface PurchasableTargets {
  brandIds: Set<string>;
  categoryPaths: string[];
  categorySlugs: Map<string, string>;
  productIds: Set<string>;
  searchable: ListedVariant[];
}

/**
 * How long a listing page may lag the shelf. Carts and checkout never use this
 * copy -- they check stock, price and the rules live -- so ten seconds is the
 * age of a number on a category page, not of anything anyone pays for.
 */
const SNAPSHOT_TTL_MS = Number(process.env.SHOP_SNAPSHOT_TTL_MS || 10_000);

/** Below this many, a shopper sees "only a few left" rather than "in stock". */
const LOW_STOCK_AT = 3;

const AVAILABILITY_FOR: Record<OrderFulfilment, readonly string[]> = {
  pickup: ['pickup_only', 'pickup_and_delivery'],
  delivery: ['delivery_only', 'pickup_and_delivery'],
};

/**
 * What the website shows.
 *
 * An item appears only when every one of these is true at once: it is listed
 * for the way the shopper is getting their order (pickup or delivery), it is
 * active, it has a price, and the compliance engine allows it to be sold that
 * way here, now. Missing any one, it does not exist as far as a shopper can
 * tell -- not "unavailable", not greyed out, simply not there -- because "we
 * have it but may not sell it to you online" is not a useful thing to show
 * anyone. Stock is different: a listed item with none left shows as out of
 * stock, because "come back later" is.
 *
 * Listings are assembled into one snapshot per store and fulfilment, and
 * filtered in memory. A single shop lists hundreds of items, not millions, and
 * doing it this way means the compliance engine is asked about the whole
 * listing at once rather than once per product card.
 */
@Injectable()
export class ShopCatalogService {
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    private readonly db: DatabaseService,
    private readonly compliance: ComplianceService,
    private readonly images: ProductImagesService,
    private readonly mailer: TransactionalMailer,
    private readonly delivery: DeliverySettingsService,
    private readonly payments: PaymentsService,
  ) {}

  async info(shop: ShopClient): Promise<ShopInfo> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{
        shop_name: string;
        name: string;
        phone: string | null;
        email: string | null;
        address_line1: string | null;
        address_line2: string | null;
        city: string | null;
        region: string | null;
        postal_code: string | null;
        timezone: string;
      }>(
        `SELECT o.display_name AS shop_name, s.name, s.phone, s.email, s.address_line1, s.address_line2,
                s.city, s.region, s.postal_code, s.timezone
         FROM stores s JOIN organizations o ON o.id = s.org_id
         WHERE s.id = $1`,
        [shop.storeId],
      );
      const store = rows[0];
      if (!store) throw ApiException.notFound('store');

      const { rows: hours } = await tx.query<{
        day_of_week: number;
        opens_at: string;
        closes_at: string;
        channel: string;
      }>(
        `SELECT day_of_week, to_char(opens_at, 'HH24:MI') AS opens_at,
                to_char(closes_at, 'HH24:MI') AS closes_at, channel
         FROM store_hours
         WHERE store_id = $1 AND channel IN ('pickup', 'store')
         ORDER BY day_of_week`,
        [shop.storeId],
      );
      // Pickup hours where the shop set them, its opening hours otherwise.
      const pickup = hours.filter((row) => row.channel === 'pickup');
      const chosen = pickup.length > 0 ? pickup : hours.filter((row) => row.channel === 'store');

      const offer = await this.delivery.offerTx(tx, shop.storeId);
      const { rows: loyalty } = await tx.query<{ name: string; is_active: boolean; rate: string }>(
        `SELECT name, is_active, earn_points_per_dollar::text AS rate FROM loyalty_settings
         WHERE org_id = current_setting('app.org_id')::uuid`,
      );

      const { shop_name, ...storeFields } = store;
      return {
        shop_name,
        store: storeFields,
        hours: chosen.map(({ day_of_week, opens_at, closes_at }) => ({ day_of_week, opens_at, closes_at })),
        test_mode: !this.mailer.sendsRealEmail(),
        delivery: {
          enabled: offer.offered,
          simulated: offer.simulated,
          provider_name: offer.providerName,
          postal_codes: offer.offered ? offer.terms.postal_codes.slice() : [],
          fee_minor: offer.terms.fee_minor.toString(),
          free_over_minor: offer.terms.free_over_minor?.toString() ?? null,
          minimum_subtotal_minor: offer.terms.minimum_subtotal_minor.toString(),
        },
        payments_simulated: this.payments.mode() === 'simulated',
        loyalty: {
          active: loyalty[0]?.is_active ?? false,
          name: loyalty[0]?.name ?? 'Rewards',
          points_per_dollar: loyalty[0]?.rate ?? '1',
        },
      };
    });
  }

  async categories(shop: ShopClient, fulfilment: OrderFulfilment = 'pickup'): Promise<ShopCategory[]> {
    const snapshot = await this.snapshot(shop, fulfilment);
    return this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        slug: string;
        name: string;
        parent_id: string | null;
        depth: number;
        path: string;
      }>(
        `SELECT id, slug, name, parent_id, depth, path
         FROM categories WHERE status = 'active'
         ORDER BY path, sort_order, name`,
      );
      return rows
        .map((category) => {
          const products = new Set(
            snapshot.variants
              .filter((v) => v.categoryPath !== null && isWithin(v.categoryPath, category.path))
              .map((v) => v.productId),
          );
          return {
            id: category.id,
            slug: category.slug,
            name: category.name,
            parent_id: category.parent_id,
            depth: category.depth,
            product_count: products.size,
          };
        })
        .filter((category) => category.product_count > 0);
    });
  }

  async products(shop: ShopClient, query: ProductQuery, fulfilment: OrderFulfilment = 'pickup'): Promise<ShopProductList> {
    const snapshot = await this.snapshot(shop, fulfilment);
    let variants = snapshot.variants;

    if (query.category) {
      const path = await this.categoryPath(shop, query.category);
      variants = path === null ? [] : variants.filter((v) => v.categoryPath !== null && isWithin(v.categoryPath, path));
    }
    if (query.brand) variants = variants.filter((v) => v.brandId === query.brand);
    if (query.q?.trim()) variants = variants.filter((v) => matches(v, query.q!));

    let cards = toCards(variants);
    if (query.inStock) cards = cards.filter((card) => card.stock !== 'out_of_stock');
    cards = sortCards(cards, query.sort ?? 'featured', variants);

    const pageSize = Math.min(Math.max(query.pageSize ?? 24, 1), 48);
    const page = Math.max(query.page ?? 1, 1);
    return {
      items: cards.slice((page - 1) * pageSize, page * pageSize),
      total: cards.length,
      page,
      page_size: pageSize,
    };
  }

  async product(shop: ShopClient, productId: string, fulfilment: OrderFulfilment = 'pickup'): Promise<ShopProductDetail> {
    const snapshot = await this.snapshot(shop, fulfilment);
    const variants = snapshot.variants
      .filter((v) => v.productId === productId)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.variantName ?? '').localeCompare(b.variantName ?? ''));
    const card = toCards(variants)[0];
    if (!card) throw ApiException.notFound('product');

    const images = await this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string; alt_text: string | null }>(
        `SELECT id, alt_text FROM product_images
         WHERE product_id = $1 OR variant_id = ANY($2::uuid[])
         ORDER BY (variant_id IS NULL) DESC, sort_order, created_at`,
        [productId, variants.map((v) => v.variantId)],
      );
      return rows;
    });

    return {
      ...card,
      description: variants[0]!.description,
      images,
      variants: variants.map((v) => ({
        id: v.variantId,
        name: variants.length === 1 ? null : v.variantName,
        attributes: v.attributes,
        price_minor: v.priceMinor,
        stock: stockOf(v.sellable),
        max_per_order: v.maxPerOrder,
        image_id: v.variantImageId,
      })),
      id_required: variants.some((v) => v.idRequired),
    };
  }

  async brand(
    shop: ShopClient,
    brandId: string,
    fulfilment: OrderFulfilment = 'pickup',
  ): Promise<{ id: string; name: string; product_count: number }> {
    const snapshot = await this.snapshot(shop, fulfilment);
    const variants = snapshot.variants.filter((v) => v.brandId === brandId);
    if (variants.length === 0) throw ApiException.notFound('brand');
    return {
      id: brandId,
      name: variants[0]!.brandName ?? '',
      product_count: new Set(variants.map((v) => v.productId)).size,
    };
  }

  async suggest(shop: ShopClient, q: string, fulfilment: OrderFulfilment = 'pickup'): Promise<ShopSuggestion[]> {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const snapshot = await this.snapshot(shop, fulfilment);

    // A scanned or typed barcode is the most specific thing anyone can search
    // for, so an exact one comes first.
    const exact = snapshot.variants.filter((v) => v.sku === q.trim() || v.barcodes.includes(q.trim()));
    const products = toCards([...exact, ...snapshot.variants.filter((v) => matches(v, term))]).slice(0, 5);

    const brands = new Map<string, { name: string; products: Set<string> }>();
    const categories = new Map<string, { name: string; slug: string; products: Set<string> }>();
    for (const v of snapshot.variants) {
      if (v.brandId && v.brandName?.toLowerCase().includes(term)) {
        const entry = brands.get(v.brandId) ?? { name: v.brandName, products: new Set<string>() };
        entry.products.add(v.productId);
        brands.set(v.brandId, entry);
      }
      if (v.categoryId && v.categorySlug && v.categoryName?.toLowerCase().includes(term)) {
        const entry = categories.get(v.categoryId) ?? {
          name: v.categoryName,
          slug: v.categorySlug,
          products: new Set<string>(),
        };
        entry.products.add(v.productId);
        categories.set(v.categoryId, entry);
      }
    }

    const count = (n: number) => `${n} product${n === 1 ? '' : 's'}`;
    return [
      ...products.map((card) => ({
        kind: 'product' as const,
        id: card.id,
        label: card.name,
        detail: card.brand?.name ?? null,
        slug: null,
      })),
      ...[...brands.entries()].slice(0, 3).map(([id, b]) => ({
        kind: 'brand' as const,
        id,
        label: b.name,
        detail: count(b.products.size),
        slug: null,
      })),
      ...[...categories.entries()].slice(0, 3).map(([id, c]) => ({
        kind: 'category' as const,
        id,
        label: c.name,
        detail: count(c.products.size),
        slug: c.slug,
      })),
    ];
  }

  /**
   * A product photo, but only one the website may show. An image id for an
   * unlisted product answers exactly as a missing one does.
   */
  async image(shop: ShopClient, imageId: string, size: 'full' | 'thumb') {
    const owner = await this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{ product_id: string | null; variant_id: string | null }>(
        `SELECT product_id, variant_id FROM product_images WHERE id = $1`,
        [imageId],
      );
      return rows[0];
    });
    const shows = (variants: ListedVariant[]) =>
      variants.some((v) => v.productId === owner?.product_id || v.variantId === owner?.variant_id);
    const visible =
      owner &&
      (shows((await this.snapshot(shop, 'pickup')).variants) || shows((await this.snapshot(shop, 'delivery')).variants));
    if (!visible) throw ApiException.notFound('image');
    return this.images.read(shop.orgId, imageId, size);
  }

  /** Brands, categories and products with something in stock online, whether for pickup or delivery. */
  async purchasable(shop: ShopClient): Promise<PurchasableTargets> {
    const inStock = [
      ...(await this.snapshot(shop, 'pickup')).variants,
      ...(await this.snapshot(shop, 'delivery')).variants,
    ].filter((v) => v.sellable >= 1);
    const categorySlugs = new Map<string, string>();
    for (const v of inStock) if (v.categorySlug && v.categoryPath) categorySlugs.set(v.categorySlug, v.categoryPath);
    return {
      brandIds: new Set(inStock.flatMap((v) => (v.brandId ? [v.brandId] : []))),
      categoryPaths: [...new Set(inStock.flatMap((v) => (v.categoryPath ? [v.categoryPath] : [])))],
      categorySlugs,
      productIds: new Set(inStock.map((v) => v.productId)),
      searchable: inStock,
    };
  }

  /** Every variant the website may sell right now for this fulfilment, allowed by the rules. Ten seconds old at most. */
  async snapshot(shop: ShopClient, fulfilment: OrderFulfilment = 'pickup'): Promise<Snapshot> {
    const key = `${shop.storeId}:${fulfilment}`;
    const cached = this.snapshots.get(key);
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached;

    const variants = await this.db.withOrg(shop.orgId, async (tx) => {
      const listed = await this.listedVariants(tx, shop.storeId, fulfilment);
      if (listed.length === 0) return [];
      const decisions = await this.decisions(
        tx,
        shop.storeId,
        listed.map((v) => v.variantId),
        fulfilment,
      );
      return listed.flatMap((variant) => {
        const decision = decisions.get(variant.variantId);
        if (!decision?.allowed) return [];
        return [
          {
            ...variant,
            minimumAge: maxAge(variant.minimumAge, decision.minimumAge),
            idRequired: variant.idRequired || decision.requiresIdScan,
          },
        ];
      });
    });

    const snapshot = { at: Date.now(), variants };
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  /** The compliance engine's decision for each variant, for this fulfilment at this store, now. */
  async decisions(
    tx: PoolClient,
    storeId: string,
    variantIds: string[],
    fulfilment: OrderFulfilment,
  ): Promise<Map<string, LineDecision>> {
    const decisions = await this.compliance.checkCartTx(
      tx,
      fulfilment,
      await this.jurisdiction(tx, storeId),
      variantIds,
      new Date(),
    );
    return new Map(decisions.map((decision) => [decision.variantId, decision]));
  }

  private async listedVariants(tx: PoolClient, storeId: string, fulfilment: OrderFulfilment): Promise<ListedVariant[]> {
    const { rows } = await tx.query<{
      variant_id: string;
      product_id: string;
      product_name: string;
      description: string | null;
      brand_id: string | null;
      brand_name: string | null;
      category_id: string | null;
      category_slug: string | null;
      category_name: string | null;
      category_path: string | null;
      variant_name: string | null;
      attributes: Record<string, unknown> | null;
      sort_order: number;
      sku: string;
      barcodes: string[];
      price_minor: string | null;
      sellable: string;
      max_per_order: string | null;
      variant_image_id: string | null;
      product_image_id: string | null;
      minimum_age: number | null;
      id_required: boolean;
      product_created_at: Date;
    }>(
      `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name, p.description,
              b.id AS brand_id, b.name AS brand_name,
              c.id AS category_id, c.slug AS category_slug, c.name AS category_name, c.path AS category_path,
              v.variant_name, v.attributes, v.sort_order, v.sku,
              COALESCE((SELECT array_agg(vb.barcode ORDER BY vb.barcode) FROM variant_barcodes vb
                         WHERE vb.variant_id = v.id), '{}') AS barcodes,
              COALESCE(l.online_price_minor, pr.price_minor)::text AS price_minor,
              COALESCE(a.sellable, 0)::text AS sellable,
              l.max_per_order::text AS max_per_order,
              (SELECT i.id FROM product_images i WHERE i.variant_id = v.id
                ORDER BY i.sort_order, i.created_at LIMIT 1) AS variant_image_id,
              (SELECT i.id FROM product_images i WHERE i.product_id = p.id
                ORDER BY (i.variant_id IS NULL) DESC, i.sort_order, i.created_at LIMIT 1) AS product_image_id,
              pc.minimum_age,
              COALESCE(pc.id_scan_required, false) AS id_required,
              p.created_at AS product_created_at
       FROM storefront_listings l
       -- Left, so an item listed before it was ever stocked shows as out of
       -- stock rather than silently not existing.
       LEFT JOIN storefront_availability a ON a.variant_id = l.variant_id AND a.store_id = $1
       JOIN product_variants v ON v.id = l.variant_id AND v.status = 'active'
       JOIN products p ON p.id = v.product_id AND p.status = 'active'
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id AND c.status = 'active'
       LEFT JOIN product_compliance pc ON pc.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT price_minor FROM variant_prices
         WHERE variant_id = v.id AND (store_id = $1 OR store_id IS NULL)
           AND kind = 'regular' AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())
         ORDER BY store_id NULLS LAST, effective_from DESC LIMIT 1
       ) pr ON true
       WHERE l.availability::text = ANY($2::text[])`,
      [storeId, AVAILABILITY_FOR[fulfilment]],
    );

    return rows
      .filter((row) => row.price_minor !== null)
      .map((row) => ({
        variantId: row.variant_id,
        productId: row.product_id,
        productName: row.product_name,
        description: row.description,
        brandId: row.brand_id,
        brandName: row.brand_name,
        categoryId: row.category_id,
        categorySlug: row.category_slug,
        categoryName: row.category_name,
        categoryPath: row.category_path,
        variantName: row.variant_name,
        attributes: Object.fromEntries(
          Object.entries(row.attributes ?? {}).map(([key, value]) => [key, String(value)]),
        ),
        sortOrder: row.sort_order,
        sku: row.sku,
        barcodes: row.barcodes,
        priceMinor: row.price_minor!,
        sellable: wholeUnits(row.sellable),
        maxPerOrder: row.max_per_order === null ? null : wholeUnits(row.max_per_order),
        variantImageId: row.variant_image_id,
        productImageId: row.product_image_id,
        minimumAge: row.minimum_age,
        idRequired: row.id_required,
        productCreatedAt: row.product_created_at,
      }));
  }

  private async categoryPath(shop: ShopClient, slug: string): Promise<string | null> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{ path: string }>(
        `SELECT path FROM categories WHERE slug = $1 AND status = 'active'`,
        [slug],
      );
      return rows[0]?.path ?? null;
    });
  }

  /** Where the sale happens, down to the county, for the compliance engine. */
  private async jurisdiction(tx: PoolClient, storeId: string): Promise<JurisdictionContext> {
    const { rows } = await tx.query<{
      country: string | null;
      region: string | null;
      county: string | null;
      city: string | null;
    }>(`SELECT country, region, county, city FROM stores WHERE id = $1`, [storeId]);
    const store = rows[0];
    return {
      country: store?.country ?? null,
      region: store?.region ?? null,
      county: store?.county ?? null,
      city: store?.city ?? null,
      storeId,
    };
  }
}

export function stockOf(sellable: number): ShopStock {
  if (sellable < 1) return 'out_of_stock';
  return sellable <= LOW_STOCK_AT ? 'low_stock' : 'in_stock';
}

/** `numeric(14,3)` stock as whole units. A shop does not sell 0.4 of a vape. */
export function wholeUnits(value: string): number {
  return Math.max(Math.floor(Number(value)), 0);
}

function maxAge(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Whether a category path is the given one or beneath it. `vapes.disposable` is within `vapes`. */
export function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/** Every word typed must appear somewhere a shopper would recognise the item by. */
export function matches(variant: ListedVariant, query: string): boolean {
  const haystack = [
    variant.productName,
    variant.brandName,
    variant.categoryName,
    variant.variantName,
    ...Object.values(variant.attributes),
    variant.sku,
    ...variant.barcodes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Variants grouped into the cards a listing page shows, one per product, in first-seen order. */
function toCards(variants: readonly ListedVariant[]): ShopProductCard[] {
  const byProduct = new Map<string, ListedVariant[]>();
  for (const variant of variants) {
    const list = byProduct.get(variant.productId) ?? [];
    if (!list.some((v) => v.variantId === variant.variantId)) list.push(variant);
    byProduct.set(variant.productId, list);
  }

  return [...byProduct.values()].map((list) => {
    const first = list[0]!;
    const prices = list.map((v) => BigInt(v.priceMinor));
    const bestStock = list.map((v) => stockOf(v.sellable)).sort((a, b) => stockRank(a) - stockRank(b))[0]!;
    return {
      id: first.productId,
      name: first.productName,
      brand: first.brandId ? { id: first.brandId, name: first.brandName ?? '' } : null,
      category:
        first.categoryId && first.categorySlug
          ? { id: first.categoryId, slug: first.categorySlug, name: first.categoryName ?? '' }
          : null,
      price_from_minor: prices.reduce((a, b) => (b < a ? b : a)).toString(),
      price_to_minor: prices.reduce((a, b) => (b > a ? b : a)).toString(),
      image_id: first.productImageId ?? list.find((v) => v.variantImageId)?.variantImageId ?? null,
      stock: bestStock,
      variant_count: list.length,
      minimum_age: list.reduce<number | null>((age, v) => maxAge(age, v.minimumAge), null),
    };
  });
}

function stockRank(stock: ShopStock): number {
  return stock === 'in_stock' ? 0 : stock === 'low_stock' ? 1 : 2;
}

function sortCards(cards: ShopProductCard[], sort: ProductSort, variants: readonly ListedVariant[]): ShopProductCard[] {
  const created = new Map(variants.map((v) => [v.productId, v.productCreatedAt.getTime()]));
  const byName = (a: ShopProductCard, b: ShopProductCard) => a.name.localeCompare(b.name);
  const price = (card: ShopProductCard) => BigInt(card.price_from_minor);
  const sorted = [...cards];
  switch (sort) {
    case 'price_asc':
      return sorted.sort((a, b) => (price(a) === price(b) ? byName(a, b) : price(a) < price(b) ? -1 : 1));
    case 'price_desc':
      return sorted.sort((a, b) => (price(a) === price(b) ? byName(a, b) : price(a) > price(b) ? -1 : 1));
    case 'newest':
      return sorted.sort((a, b) => (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0) || byName(a, b));
    case 'name':
      return sorted.sort(byName);
    case 'featured':
    default:
      // What can be bought today before what cannot, then alphabetically.
      return sorted.sort((a, b) => stockRank(a.stock) - stockRank(b.stock) || byName(a, b));
  }
}
