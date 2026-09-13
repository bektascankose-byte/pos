import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { formatMinor } from "@/lib/money";
import type { Product, Brand, Category, TaxCategory } from "@snappos/contracts";
import {
  updateProductAction,
  updateVariantAction,
  setPriceAction,
  addVariantAction,
} from "../actions";

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;
  const storeId = await primaryStoreId();

  let product: Product;
  let brands: Brand[] = [];
  let categories: Category[] = [];
  let taxCategories: TaxCategory[] = [];
  try {
    const qs = storeId ? `?store_id=${storeId}` : "";
    [product, brands, categories, taxCategories] = await Promise.all([
      apiFetch<Product>(`/api/v1/catalog/products/${id}${qs}`),
      apiFetch<Brand[]>(`/api/v1/catalog/brands`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
      apiFetch<TaxCategory[]>(`/api/v1/catalog/tax-categories`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const updateProduct = updateProductAction.bind(null, id);
  const addVariant = addVariantAction.bind(null, id);
  const defaultAxis = product.variant_axes[0] ?? "flavor";

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold">{product.name}</h1>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Product</h2>
        <form action={updateProduct} className="flex flex-col gap-4">
          <p className="text-xs text-[var(--color-text-muted)]">
            Leave a field blank to keep its current value.
          </p>
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
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Save product
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-[var(--color-text-muted)]">Variants</h2>
        {(product.variants ?? []).map((variant) => {
          const updateVariant = updateVariantAction.bind(null, id, variant.id);
          const setPrice = setPriceAction.bind(null, id, variant.id, storeId);
          return (
            <div
              key={variant.id}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="font-medium">{variant.variant_name ?? variant.sku}</div>
                <div className="text-sm text-[var(--color-text-muted)]">SKU {variant.sku}</div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <form action={updateVariant} className="flex flex-col gap-3">
                  <p className="text-xs text-[var(--color-text-muted)]">Blank keeps the current value.</p>
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
                    <Field
                      label="Reorder quantity"
                      name="reorder_quantity"
                      defaultValue={variant.reorder_quantity ?? ""}
                    />
                  </div>
                  <button
                    type="submit"
                    className="self-start rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
                  >
                    Save variant
                  </button>
                </form>

                <form action={setPrice} className="flex flex-col gap-3 border-l border-[var(--color-border)] pl-6">
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Current price:{" "}
                    <span className="font-medium text-[var(--color-text)]">
                      {/* `price_minor` types as the branded `Money` (bigint) here because it
                          shares `variantSchema` with request validation, but this response was
                          never actually parsed through that schema -- it's the plain digit
                          string the API sends. `String()` bridges that gap at the boundary
                          rather than pretending the type were right. */}
                      {variant.price_minor ? formatMinor(String(variant.price_minor)) : "not priced"}
                    </span>
                  </div>
                  <Field label="New price" name="price" placeholder="24.99" />
                  <button
                    type="submit"
                    className="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)]"
                  >
                    Update price
                  </button>
                </form>
              </div>
            </div>
          );
        })}
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-1 text-sm font-medium text-[var(--color-text-muted)]">Add variant</h2>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Another flavor or size of this same product -- e.g. when an invoice turns out to cover
          several variants a vendor listed as one line.
        </p>
        <form action={addVariant} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Variant name" name="variant_name" placeholder="e.g. Cherry" required />
            <Field label="SKU" name="sku" required />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label={`Attribute (${defaultAxis})`} name="attribute_value" defaultValue="" placeholder="e.g. Cherry" />
            <Field label="Cost" name="cost" defaultValue="0" />
            <Field label="Barcode" name="barcode" placeholder="optional" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Case quantity" name="case_quantity" defaultValue="1" />
            <Field label="Pack quantity" name="pack_quantity" defaultValue="1" />
          </div>
          <button
            type="submit"
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Add variant
          </button>
        </form>
      </section>
    </div>
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
