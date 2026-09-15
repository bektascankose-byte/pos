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
} from "../actions";
import {
  CodesPanel,
  MovementsPanel,
  PriceHistoryPanel,
  PricingPanel,
  VariantPicker,
} from "./ItemDetailPanels";
import type { Product, Variant, Brand, Category, TaxCategory } from "@snappos/contracts";

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
      <h1 className="text-xl font-semibold">{product.name}</h1>
      <Tabs
        tabs={[
          {
            id: "details",
            label: "Details",
            content: (
              <DetailsPanel
                product={product}
                brands={brands}
                categories={categories}
                taxCategories={taxCategories}
                onSaved={(updated) => setProduct(updated)}
              />
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
                defaultAxis={product.variant_axes[0] ?? "flavor"}
                onVariantUpdated={(updated) =>
                  setVariants((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)))
                }
                onVariantAdded={(created) => setVariants((prev) => [...prev, created])}
              />
            ),
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
          variantTab("codes", "Item Codes", (variant) => (
            <CodesPanel variant={variant} mode="unit" onChanged={reloadProduct} />
          )),
          variantTab("carton", "Carton Mapping", (variant) => (
            <CodesPanel variant={variant} mode="carton" onChanged={reloadProduct} />
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
  defaultAxis,
  onVariantUpdated,
  onVariantAdded,
}: {
  productId: string;
  storeId: string | null;
  variants: Variant[];
  defaultAxis: string;
  onVariantUpdated: (updated: Variant) => void;
  onVariantAdded: (created: Variant) => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {variants.map((variant) => (
        <VariantRow
          key={variant.id}
          productId={productId}
          storeId={storeId}
          variant={variant}
          onUpdated={onVariantUpdated}
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
  onUpdated,
}: {
  productId: string;
  storeId: string | null;
  variant: Variant;
  onUpdated: (updated: Variant) => void;
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
  const [priceMinor, setPriceMinor] = useState<string | null>(
    variant.price_minor !== undefined ? String(variant.price_minor) : null,
  );

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-medium">{variant.variant_name ?? variant.sku}</div>
        <div className="text-sm text-[var(--color-text-muted)]">SKU {variant.sku}</div>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cost" name="cost" defaultValue={variant.cost} />
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
        <Field label="SKU" name="sku" required />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label={`Attribute (${defaultAxis})`} name="attribute_value" placeholder="e.g. Cherry" />
        <Field label="Cost" name="cost" defaultValue="0" />
        <Field label="Barcode" name="barcode" placeholder="optional" />
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
