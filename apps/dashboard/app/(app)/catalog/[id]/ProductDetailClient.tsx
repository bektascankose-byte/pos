"use client";

import { useState, useTransition } from "react";
import { formatMinor } from "@/lib/money";
import { Tabs } from "../_components/Tabs";
import {
  updateProductAction,
  updateVariantAction,
  setPriceAction,
  addVariantAction,
  getProductAction,
  setProductStatusAction,
  updateComplianceAction,
} from "../actions";
import {
  CodesPanel,
  MovementsPanel,
  PriceHistoryPanel,
  PricingPanel,
  VariantPicker,
} from "./ItemDetailPanels";
import { AiFillPanel } from "./AiFillPanel";
import { FlavorTile } from "../_components/FlavorTile";
import { removeVariantAction } from "../../items/actions";
import { ImagePanel } from "./ImagePanel";
import { SellOnlinePanel } from "./SellOnlinePanel";
import type {
  Product,
  Variant,
  Brand,
  Category,
  TaxCategory,
  ProductImage,
} from "@snappos/contracts";

interface Props {
  productId: string;
  storeId: string | null;
  initialProduct: Product;
  brands: Brand[];
  categories: Category[];
  taxCategories: TaxCategory[];
}

export function ProductDetailClient({ productId, storeId, initialProduct, brands, categories, taxCategories }: Props) {
  const [product, setProduct] = useState(initialProduct);
  const [variants, setVariants] = useState<Variant[]>(initialProduct.variants ?? []);
  const [selectedVariantId, setSelectedVariantId] = useState(initialProduct.variants?.[0]?.id ?? "");

  const selected = variants.find((variant) => variant.id === selectedVariantId) ?? variants[0];

  const reloadProduct = async () => {
    const outcome = await getProductAction(productId, storeId);
    if (outcome.ok) {
      setProduct(outcome.data);
      setVariants(outcome.data.variants ?? []);
    }
  };

  /**
   * Codes, prices and history belong to one variant, not to the product, so
   * these tabs work on a selected one. For the ordinary single-variant item
   * the picker doesn't render and it reads exactly like a flat item page.
   */
  const variantTab = (id: string, label: string, render: (variant: Variant) => React.ReactNode) => ({
    id,
    label,
    content: selected ? (
      <div>
        <VariantPicker
          variants={variants}
          selectedId={selected.id}
          onSelect={setSelectedVariantId}
        />
        {render(selected)}
      </div>
    ) : (
      <p className="text-sm text-[var(--color-text-muted)]">This product has no variants yet.</p>
    ),
  });

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{product.name}</h1>
          {product.status === "archived" ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Archived — hidden from the catalog, search and the register.
            </p>
          ) : null}
        </div>
        <ArchiveButton product={product} onChanged={(updated) => setProduct(updated)} />
      </div>
      <Tabs
        tabs={[
          {
            id: "details",
            label: "Details",
            content: (
              <div className="flex flex-col gap-4">
                <AiFillPanel
                  productId={productId}
                  product={product}
                  variants={variants}
                  onApplied={reloadProduct}
                />
                <DetailsPanel
                  product={product}
                  brands={brands}
                  categories={categories}
                  taxCategories={taxCategories}
                  onSaved={(updated) => setProduct(updated)}
                />
                <CompliancePanel product={product} onSaved={(updated) => setProduct(updated)} />
                <ImagePanel
                  productId={productId}
                  variants={variants}
                  initialImages={product.images ?? []}
                />
              </div>
            ),
          },
          {
            id: "variants",
            label: "Variants",
            content: (
              <VariantsPanel
                productId={productId}
                storeId={storeId}
                variants={variants}
                images={product.images ?? []}
                defaultAxis={product.variant_axes[0] ?? "flavor"}
                onVariantUpdated={(updated) =>
                  setVariants((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)))
                }
                onVariantAdded={(created) => setVariants((prev) => [...prev, created])}
                onChanged={reloadProduct}
              />
            ),
          },
          {
            id: "online",
            label: "Sell Online",
            content: <SellOnlinePanel productId={productId} storeId={storeId} />,
          },
          variantTab("pricing", "Cost & Margin", (variant) => (
            <PricingPanel
              productId={productId}
              storeId={storeId}
              variant={variant}
              onVariantSaved={(updated) =>
                setVariants((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)))
              }
              onPriceSaved={(priceMinor) =>
                setVariants((prev) =>
                  prev.map((v) =>
                    v.id === variant.id
                      ? // `price_minor` types as the branded `Money` because
                        // `variantSchema` is shared with request validation,
                        // but on the wire it is the plain digit string the API
                        // sends -- the same gap bridged with `String()`
                        // wherever this response is displayed.
                        { ...v, price_minor: priceMinor as unknown as Variant["price_minor"] }
                      : v,
                  ),
                )
              }
            />
          )),
          variantTab("price-history", "Price History", (variant) => (
            <PriceHistoryPanel variantId={variant.id} />
          )),
          variantTab("purchases", "Purchases", (variant) => (
            <MovementsPanel variantId={variant.id} mode="purchases" />
          )),
          variantTab("sales", "Sales", (variant) => (
            <MovementsPanel variantId={variant.id} mode="sales" />
          )),
        ]}
      />
    </div>
  );
}

function ArchiveButton({
  product,
  onChanged,
}: {
  product: Product;
  onChanged: (updated: Product) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const archived = product.status === "archived";

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const outcome = await setProductStatusAction(product.id, archived ? "active" : "archived");
            if (outcome.ok) onChanged(outcome.data);
            else setError(outcome.error);
          });
        }}
        title={
          archived
            ? "Put this item back in the catalog"
            : "Hide from the catalog, search and the register. Past sales and receipts are kept."
        }
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60"
      >
        {pending ? "Saving..." : archived ? "Restore" : "Archive"}
      </button>
      {error ? <p className="mt-1 text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}

/**
 * Age restriction and what makes this item restricted. Previously only
 * settable at creation from the AI suggestion, which meant a wrong guess was
 * permanent -- and for vape, tobacco and THC this is the field the register
 * actually enforces at the counter.
 */
function CompliancePanel({
  product,
  onSaved,
}: {
  product: Product;
  onSaved: (updated: Product) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const compliance = product.compliance ?? null;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="mb-1 text-sm font-medium">Age restriction</h2>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        What the register enforces before this can be sold.
      </p>
      {message ? <p className="mb-2 text-xs text-[var(--color-text-muted)]">{message}</p> : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const outcome = await updateComplianceAction(product.id, formData);
            if (outcome.ok) {
              onSaved(outcome.data);
              setMessage("Saved.");
            } else {
              setMessage(outcome.error);
            }
          });
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Minimum age (blank = no restriction)"
            name="minimum_age"
            defaultValue={compliance?.minimum_age === null || compliance?.minimum_age === undefined ? "" : String(compliance.minimum_age)}
          />
          <Field
            label="Regulated class"
            name="regulated_class"
            defaultValue={compliance?.regulated_class ?? ""}
            placeholder="ends, tobacco, consumable_hemp, kratom"
          />
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <Checkbox label="Scan an ID" name="id_scan_required" defaultChecked={compliance?.id_scan_required ?? false} />
          <Checkbox label="Contains nicotine" name="contains_nicotine" defaultChecked={compliance?.contains_nicotine ?? false} />
          <Checkbox label="Contains cannabinoid" name="contains_cannabinoid" defaultChecked={compliance?.contains_cannabinoid ?? false} />
          <Checkbox label="Smokable" name="is_smokable" defaultChecked={compliance?.is_smokable ?? false} />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save age restriction"}
        </button>
      </form>
    </section>
  );
}

function Checkbox({
  label,
  name,
  defaultChecked,
}: {
  label: string;
  name: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      {label}
    </label>
  );
}

function DetailsPanel({
  product,
  brands,
  categories,
  taxCategories,
  onSaved,
}: {
  product: Product;
  brands: Brand[];
  categories: Category[];
  taxCategories: TaxCategory[];
  onSaved: (updated: Product) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {message ? (
        <p
          className={`mb-3 text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}
        >
          {message.text}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const result = await updateProductAction(product.id, formData);
            if (result.ok) {
              onSaved(result.data);
              setMessage({ kind: "success", text: "Saved." });
            } else {
              setMessage({ kind: "error", text: result.error });
            }
          });
        }}
      >
        <p className="text-xs text-[var(--color-text-muted)]">Leave a field blank to keep its current value.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" name="name" defaultValue={product.name} />
          <Field label="Short name (receipt)" name="short_name" defaultValue={product.short_name ?? ""} />
        </div>
        <Field label="Description" name="description" defaultValue={product.description ?? ""} textarea />
        <div className="grid grid-cols-3 gap-4">
          <Select label="Brand" name="brand_id" current={product.brand_id} options={brands} />
          <Select label="Category" name="category_id" current={product.category_id} options={categories} />
          <Select
            label="Tax category"
            name="tax_category_id"
            current={product.tax_category_id}
            options={taxCategories}
          />
        </div>
        <Field label="Tags (comma separated)" name="tags" defaultValue={product.tags.join(", ")} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save product"}
        </button>
      </form>
    </section>
  );
}

function VariantsPanel({
  productId,
  storeId,
  variants,
  images,
  defaultAxis,
  onVariantUpdated,
  onVariantAdded,
  onChanged,
}: {
  productId: string;
  storeId: string | null;
  variants: Variant[];
  images: ProductImage[];
  defaultAxis: string;
  onVariantUpdated: (updated: Variant) => void;
  onVariantAdded: (created: Variant) => void;
  onChanged: () => Promise<void>;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  // A to Z by flavor, so one is found by its name. A flavor with no name yet
  // comes first: it is the one that needs something done to it.
  const ordered = [...variants].sort((a, b) => {
    const nameA = a.variant_name?.trim() ?? "";
    const nameB = b.variant_name?.trim() ?? "";
    if (!nameA !== !nameB) return nameA ? 1 : -1;
    return (nameA || a.sku).localeCompare(nameB || b.sku, "en", { sensitivity: "base", numeric: true });
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-text-muted)]">
        The flavors this item is sold in, A to Z. Each one carries its own photo, its own barcode and
        the carton code that rings up a case of it. A cashier scans one of these, never the item above.
      </p>

      {ordered.map((variant) => (
        <VariantRow
          key={variant.id}
          productId={productId}
          storeId={storeId}
          variant={variant}
          image={images.find((image) => image.variant_id === variant.id) ?? null}
          onUpdated={onVariantUpdated}
          onChanged={onChanged}
        />
      ))}

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        {showAddForm ? (
          <AddVariantForm
            productId={productId}
            defaultAxis={defaultAxis}
            onAdded={(created) => {
              onVariantAdded(created);
              setShowAddForm(false);
            }}
            onCancel={() => setShowAddForm(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
          >
            + Add variant
          </button>
        )}
      </section>
    </div>
  );
}

function VariantRow({
  productId,
  storeId,
  variant,
  image,
  onUpdated,
  onChanged,
}: {
  productId: string;
  storeId: string | null;
  variant: Variant;
  image: ProductImage | null;
  onUpdated: (updated: Variant) => void;
  onChanged: () => Promise<void>;
}) {
  const [fieldsPending, startFieldsTransition] = useTransition();
  const [pricePending, startPriceTransition] = useTransition();
  const [fieldsMessage, setFieldsMessage] = useState<string | null>(null);
  const [priceMessage, setPriceMessage] = useState<string | null>(null);
  // `variant.price_minor` types as the branded `Money` here because it shares
  // `variantSchema` with request validation, but this response was never
  // actually parsed through that schema -- it's the plain digit string the
  // API sends. `String()` bridges that gap at the boundary, same as
  // elsewhere this response crosses from server to client.
  //
  // A flavor that has no price yet comes back as null, not undefined: the AI
  // draft creates flavors before anyone has priced them. `String(null)` is
  // the text "null", which is truthy and crashed the page in `formatMinor`.
  const [priceMinor, setPriceMinor] = useState<string | null>(
    variant.price_minor === undefined || variant.price_minor === null ? null : String(variant.price_minor),
  );

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center gap-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-[var(--color-bg)]">
          {image ? (
            /* eslint-disable-next-line @next/next/no-img-element -- our own proxy, not a known-size remote */
            <img
              src={`/api/product-images/${image.id}?size=thumb`}
              alt={image.alt_text ?? ""}
              className="h-full w-full object-contain"
            />
          ) : (
            <FlavorTile name={variant.variant_name ?? variant.sku} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{variant.variant_name ?? variant.sku}</div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {variant.sku}
            {image ? null : " · no photo yet"}
          </div>
        </div>
        <RemoveVariantButton productId={productId} variant={variant} onRemoved={onChanged} />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            startFieldsTransition(async () => {
              const result = await updateVariantAction(productId, variant.id, formData);
              if (result.ok) {
                onUpdated(result.data);
                setFieldsMessage("Saved.");
              } else {
                setFieldsMessage(result.error);
              }
            });
          }}
        >
          <p className="text-xs text-[var(--color-text-muted)]">Blank keeps the current value.</p>
          {fieldsMessage ? <p className="text-xs text-[var(--color-text-muted)]">{fieldsMessage}</p> : null}
          {/* The flavor as the register shows it under the product's folder.
              Imported items often have none: the flavor sat in the product
              name, one item per flavor. */}
          <Field label="Flavor name" name="variant_name" defaultValue={variant.variant_name ?? ""} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="PLU (keypad code)" name="plu" defaultValue={variant.plu ?? ""} />
            <Field label="Cost" name="cost" defaultValue={variant.cost} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Status"
              name="status"
              current={variant.status}
              options={[
                { id: "active", name: "Active" },
                { id: "inactive", name: "Inactive" },
                { id: "archived", name: "Archived" },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Case quantity" name="case_quantity" defaultValue={String(variant.case_quantity)} />
            <Field label="Pack quantity" name="pack_quantity" defaultValue={String(variant.pack_quantity)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reorder point" name="reorder_point" defaultValue={variant.reorder_point ?? ""} />
            <Field label="Reorder quantity" name="reorder_quantity" defaultValue={variant.reorder_quantity ?? ""} />
          </div>
          <button
            type="submit"
            disabled={fieldsPending}
            className="self-start rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-60"
          >
            {fieldsPending ? "Saving..." : "Save variant"}
          </button>
        </form>

        <form
          className="flex flex-col gap-3 border-l border-[var(--color-border)] pl-6"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            startPriceTransition(async () => {
              const result = await setPriceAction(productId, variant.id, storeId, formData);
              if (result.ok) {
                setPriceMinor(result.data.price_minor);
                setPriceMessage("Updated.");
              } else {
                setPriceMessage(result.error);
              }
            });
          }}
        >
          <div className="text-xs text-[var(--color-text-muted)]">
            Current price:{" "}
            <span className="font-medium text-[var(--color-text)]">
              {priceMinor ? formatMinor(String(priceMinor)) : "not priced"}
            </span>
          </div>
          {priceMessage ? <p className="text-xs text-[var(--color-text-muted)]">{priceMessage}</p> : null}
          <Field label="New price" name="price" placeholder="24.99" />
          <button
            type="submit"
            disabled={pricePending}
            className="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pricePending ? "Updating..." : "Update price"}
          </button>
        </form>
      </div>

      {/*
        The codes live with the flavor they scan, not on tabs of their own.
        A flavor's single barcode and the carton code that rings up a case of
        it are two facts about this one thing; keeping them on separate pages
        behind a variant picker meant setting up one flavor took three
        screens, and made it easy to leave with a flavor that had no barcode
        at all -- which is the one state that cannot be sent to a register.
      */}
      <div className="mt-4 grid gap-4 border-t border-[var(--color-border)] pt-4 md:grid-cols-2">
        <CodesPanel variant={variant} mode="unit" onChanged={onChanged} />
        <CodesPanel variant={variant} mode="carton" onChanged={onChanged} />
      </div>
    </div>
  );
}

/**
 * Stop selling a flavor.
 *
 * Confirms first, because the two outcomes are not equally reversible and the
 * person cannot tell from here which one they will get: a flavor with no
 * history is gone for good, while one with sales is only archived. Saying so
 * afterwards rather than guessing beforehand keeps the message true either
 * way -- and a flavor still on the registers keeps selling there until the
 * next Send, which is the part most worth stating out loud.
 */
function RemoveVariantButton({
  productId,
  variant,
  onRemoved,
}: {
  productId: string;
  variant: Variant;
  onRemoved: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const name = variant.variant_name ?? variant.sku;

  if (message) {
    return <span className="max-w-64 text-right text-xs text-[var(--color-text-muted)]">{message}</span>;
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)]"
      >
        Remove
      </button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-xs text-[var(--color-text-muted)]">Stop selling {name}?</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const result = await removeVariantAction(productId, variant.id);
            if (!result.ok) {
              setMessage(result.error);
              return;
            }
            setMessage(
              result.data.outcome === "deleted"
                ? `${name} deleted.`
                : `${name} discontinued — ${result.data.reason ?? "it has history on record."}`,
            );
            await onRemoved();
          });
        }}
        className="rounded bg-[var(--color-error)] px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-xs text-[var(--color-text-muted)] underline"
      >
        Keep
      </button>
    </div>
  );
}

function AddVariantForm({
  productId,
  defaultAxis,
  onAdded,
  onCancel,
}: {
  productId: string;
  defaultAxis: string;
  onAdded: (created: Variant) => void;
  onCancel: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await addVariantAction(productId, formData);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          // The endpoint only ever returns {id, sku} -- the rest of this
          // row's fields are exactly what was just submitted, so building
          // the full row from the form avoids a stale/blank-looking card
          // until the next full page load.
          const attributeValue = String(formData.get("attribute_value") ?? "").trim();
          onAdded({
            id: result.data.id,
            product_id: productId,
            sku: result.data.sku,
            plu: null,
            variant_name: String(formData.get("variant_name") ?? "").trim() || null,
            attributes: attributeValue ? { [defaultAxis]: attributeValue } : {},
            is_default: false,
            sort_order: 0,
            cost: String(formData.get("cost") ?? "0"),
            average_cost: String(formData.get("cost") ?? "0"),
            last_cost: null,
            case_quantity: Number(formData.get("case_quantity") ?? 1),
            pack_quantity: Number(formData.get("pack_quantity") ?? 1),
            case_cost: null,
            case_discount: "0",
            case_rebate: "0",
            default_margin: null,
            reorder_point: null,
            reorder_quantity: null,
            status: "active",
          });
        });
      }}
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--color-text-muted)]">Add variant</h2>
        <button type="button" onClick={onCancel} className="text-xs text-[var(--color-text-muted)] underline">
          Cancel
        </button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Another flavor or size of this same product -- e.g. when an invoice turns out to cover several
        variants a vendor listed as one line.
      </p>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Variant name" name="variant_name" placeholder="e.g. Cherry" required />
        {/* One box: the UPC is both this variant's code and what a scanner
            reads. Carton codes are added on the item's own page, where they
            can carry the units-per-scan they need. */}
        <Field label="UPC / Barcode" name="sku" required />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label={`Attribute (${defaultAxis})`} name="attribute_value" placeholder="e.g. Cherry" />
        <Field label="Cost" name="cost" defaultValue="0" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Case quantity" name="case_quantity" defaultValue="1" />
        <Field label="Pack quantity" name="pack_quantity" defaultValue="1" />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
      >
        {pending ? "Adding..." : "Add variant"}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  textarea,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  textarea?: boolean;
  required?: boolean;
}) {
  const className =
    "rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {textarea ? (
        <textarea name={name} defaultValue={defaultValue} placeholder={placeholder} rows={3} className={className} />
      ) : (
        <input
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          required={required}
          className={className}
        />
      )}
    </label>
  );
}

function Select({
  label,
  name,
  current,
  options,
}: {
  label: string;
  name: string;
  current: string | null;
  options: { id: string; name: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        name={name}
        defaultValue={current ?? ""}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      >
        <option value="">Unchanged</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
