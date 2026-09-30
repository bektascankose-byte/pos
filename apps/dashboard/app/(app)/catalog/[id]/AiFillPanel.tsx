"use client";

import { useState, useTransition } from "react";
import type { AiProductDraft, Product, Variant } from "@snappos/contracts";
import { aiFillProductAction, aiFindImagesAction, applyAiDraftAction } from "./ai-actions";
import { uploadProductImageAction } from "./image-actions";
import { downscale, DISPLAY_MAX, THUMB_MAX } from "./ImagePanel";

/**
 * Draft this whole item from the web, then keep what is right.
 *
 * The shape of this panel is the point. Everything it finds is shown before
 * anything is written, and each part can be dropped on its own, because the
 * cost of a wrong catalog entry is not symmetric: a missing description is
 * invisible, while a wrong age restriction sells nicotine to a seventeen year
 * old and a wrong flavour list puts items on a till that the shop does not
 * stock. So the button says what it found, not what it did.
 *
 * Barcodes, costs and prices are never drafted. A barcode the AI invented
 * would scan as the wrong item at the counter and a price it invented is
 * money, so those stay typed in by hand -- which is also why new flavours
 * arrive unfinished and cannot be sent to a register until someone fills them.
 */
export function AiFillPanel({
  productId,
  product,
  variants,
  onApplied,
}: {
  productId: string;
  product: Product;
  variants: Variant[];
  onApplied: (product: Product) => Promise<void>;
}) {
  const [hint, setHint] = useState("");
  const [draft, setDraft] = useState<AiProductDraft | null>(null);
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const [chosenFlavors, setChosenFlavors] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const working = busy || pending;
  const newFlavors = (draft?.variants ?? []).filter((v) => !v.existing_variant_id);
  // The item already on the shelf, recognised as one of the flavors but not
  // yet named as one (imported one item per flavor, flavor in the product
  // name). Saving names it instead of adding a second copy beside it.
  const isUnnamed = (variantId: string | null) =>
    variantId !== null && !variants.find((v) => v.id === variantId)?.variant_name?.trim();
  const toName = (draft?.variants ?? [])
    .filter((v) => isUnnamed(v.existing_variant_id))
    .map((v) => ({ id: v.existing_variant_id as string, name: v.name }));

  const run = () => {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const result = await aiFillProductAction(productId, hint);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(result.data);
      // Everything on by default except the name: renaming an item somebody
      // already named, and that already prints on receipts and shelf labels,
      // is the one change worth opting into rather than out of.
      setKeep({
        name: false,
        short_name: true,
        description: true,
        brand: Boolean(result.data.brand),
        category: Boolean(result.data.category_id || result.data.new_category),
        tax: Boolean(result.data.tax_category_id),
        tags: result.data.tags.length > 0,
        compliance: true,
      });
      setChosenFlavors(new Set(result.data.variants.filter((v) => !v.existing_variant_id).map((v) => v.name)));
    });
  };

  const apply = () => {
    if (!draft) return;
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const result = await applyAiDraftAction(productId, {
        ...(keep.name ? { name: draft.name } : {}),
        ...(keep.short_name ? { short_name: draft.short_name } : {}),
        ...(keep.description ? { description: draft.description } : {}),
        ...(keep.brand && draft.brand_id ? { brand_id: draft.brand_id } : {}),
        ...(keep.brand && !draft.brand_id && draft.brand ? { brand_name: draft.brand } : {}),
        ...(keep.category && draft.category_id ? { category_id: draft.category_id } : {}),
        ...(keep.category && !draft.category_id && draft.new_category
          ? {
              category_name: draft.new_category,
              ...(draft.new_category_parent_id ? { category_parent_id: draft.new_category_parent_id } : {}),
            }
          : {}),
        ...(keep.tax ? { tax_category_id: draft.tax_category_id } : {}),
        ...(keep.tags ? { tags: draft.tags } : {}),
        ...(keep.compliance ? { compliance: draft.compliance } : {}),
        newVariants: [...chosenFlavors],
        nameVariants: toName,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { created, named, failed, priceGroup } = result.data;
      setStatus(
        `Saved${named > 0 ? `, your current item named ${toName.map((v) => v.name).join(", ")}` : ""}` +
          `${created > 0 ? `, ${created} new ${created === 1 ? "flavor" : "flavors"} added` : ""}.` +
          (failed.length > 0 ? ` Could not add: ${failed.join(", ")}.` : "") +
          (created > 0
            ? " Each needs a price before it can go to the registers. Barcodes can wait until the stock arrives."
            : "") +
          // Only when saving actually made one. Saying so every time would
          // read as though the group were new on every redraft.
          (priceGroup?.created
            ? ` Price group "${priceGroup.name}" made with every flavor.`
            : ""),
      );
      setDraft(null);
      await onApplied(result.data.product);
    });
  };

  /**
   * Find and store a photo for every flavour that has none.
   *
   * The bytes come through this app's own origin so the ordinary downscaler
   * can touch them, then go up the ordinary upload path. Each photo is saved
   * as it arrives rather than collected and saved at the end: finding eight
   * photos takes a while, and a failure on the seventh should not throw away
   * the six that worked.
   */
  const findPhotos = async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const withoutPhoto = variants.filter(
        (variant) => !(product.images ?? []).some((image) => image.variant_id === variant.id),
      );
      const names = withoutPhoto.map((v) => v.variant_name ?? v.sku);
      if (names.length === 0) {
        setStatus("Every flavor already has a photo.");
        return;
      }

      setStatus(`Looking for ${names.length} ${names.length === 1 ? "photo" : "photos"}…`);
      const found = await aiFindImagesAction(productId, names);
      if (!found.ok) {
        setError(found.error);
        return;
      }

      let saved = 0;
      const missed: string[] = [];
      for (const candidate of found.data.images) {
        const variant = candidate.variant_name
          ? withoutPhoto.find((v) => (v.variant_name ?? v.sku) === candidate.variant_name)
          : undefined;
        // Only flavours that asked for one. The product-wide entry is skipped
        // here: this button is for filling the gaps in the grid.
        if (!variant || !candidate.image_url) {
          if (candidate.variant_name) missed.push(candidate.variant_name);
          continue;
        }

        try {
          const response = await fetch(`/api/stock-image?url=${encodeURIComponent(candidate.image_url)}`);
          if (!response.ok) throw new Error("fetch failed");
          const blob = await response.blob();
          const [display, thumb] = await Promise.all([
            downscale(blob, DISPLAY_MAX),
            downscale(blob, THUMB_MAX),
          ]);

          const formData = new FormData();
          formData.set("file", display);
          formData.set("thumb", thumb);
          formData.set("variant_id", variant.id);
          formData.set("alt_text", `${product.name} — ${candidate.variant_name}`);
          if (candidate.page_url) formData.set("source_url", candidate.page_url);

          const uploaded = await uploadProductImageAction(productId, formData);
          if (uploaded.ok) saved += 1;
          else missed.push(candidate.variant_name ?? variant.sku);
        } catch {
          missed.push(candidate.variant_name ?? variant.sku);
        }
      }

      const notFound = names.filter(
        (name) => !found.data.images.some((image) => image.variant_name === name && image.image_url),
      );
      setStatus(
        `Saved ${saved} ${saved === 1 ? "photo" : "photos"}.` +
          (notFound.length > 0 ? ` No photo found for: ${notFound.join(", ")}.` : "") +
          (missed.length > 0 && notFound.length === 0 ? ` Could not save: ${missed.join(", ")}.` : ""),
      );
      await onApplied(product);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Draft this item with AI</h2>
          <p className="max-w-xl text-xs text-[var(--color-text-muted)]">
            Searches the web for this product and drafts its name, receipt name, description, brand,
            category, tax category, tags, age restriction and the flavors it is sold in. Nothing is
            saved until you say so. Barcodes, costs and prices are never guessed — you type those.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex w-48 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Steer it (optional)
            <input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="the 5 pack, not the single"
              className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="button"
            onClick={run}
            disabled={working}
            className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
          >
            {working && !draft ? "Searching…" : "Draft with AI"}
          </button>
          <button
            type="button"
            onClick={() => void findPhotos()}
            disabled={working}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-40"
          >
            Find photos
          </button>
        </div>
      </div>

      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      {status ? <p className="text-xs text-[var(--color-text-muted)]">{status}</p> : null}

      {draft ? (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
          <DraftRow
            id="name"
            label="Name"
            value={draft.name}
            note={draft.name === product.name ? "same as now" : `now: ${product.name}`}
            keep={keep}
            setKeep={setKeep}
          />
          <DraftRow id="short_name" label="Receipt name" value={draft.short_name} keep={keep} setKeep={setKeep} />
          <DraftRow id="description" label="Description" value={draft.description} keep={keep} setKeep={setKeep} />
          <DraftRow
            id="brand"
            label="Brand"
            value={draft.brand ?? "—"}
            note={draft.brand && !draft.brand_id ? "new brand, added when you save" : undefined}
            disabled={!draft.brand}
            keep={keep}
            setKeep={setKeep}
          />
          <DraftRow
            id="category"
            label="Category"
            value={draft.category ?? draft.new_category ?? "—"}
            note={
              draft.category_id
                ? undefined
                : draft.new_category
                  ? `new category${draft.new_category_parent ? ` under ${draft.new_category_parent}` : ""}, added when you save`
                  : "could not be matched to your categories"
            }
            disabled={!draft.category_id && !draft.new_category}
            keep={keep}
            setKeep={setKeep}
          />
          <DraftRow
            id="tax"
            label="Tax category"
            value={draft.tax_category_code ?? "—"}
            note={!draft.tax_category_id ? "could not be matched to your tax categories" : undefined}
            disabled={!draft.tax_category_id}
            keep={keep}
            setKeep={setKeep}
          />
          <DraftRow id="tags" label="Tags" value={draft.tags.join(", ") || "—"} keep={keep} setKeep={setKeep} />
          <DraftRow
            id="compliance"
            label="Age restriction"
            value={describeCompliance(draft)}
            keep={keep}
            setKeep={setKeep}
          />

          <div className="border-t border-[var(--color-border)] pt-3">
            <p className="text-xs font-medium">
              Flavors found{draft.variant_axis ? ` (by ${draft.variant_axis})` : ""}
            </p>
            {draft.variants.length === 0 ? (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">None found.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {draft.variants.map((flavor) => (
                  <li key={flavor.name}>
                    <label
                      className={
                        flavor.existing_variant_id
                          ? "flex cursor-default items-center gap-1.5 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)]"
                          : "flex cursor-pointer items-center gap-1.5 rounded border border-[var(--color-border)] px-2 py-1 text-xs"
                      }
                    >
                      <input
                        type="checkbox"
                        disabled={Boolean(flavor.existing_variant_id)}
                        checked={chosenFlavors.has(flavor.name) || isUnnamed(flavor.existing_variant_id)}
                        onChange={() =>
                          setChosenFlavors((previous) => {
                            const next = new Set(previous);
                            if (next.has(flavor.name)) next.delete(flavor.name);
                            else next.add(flavor.name);
                            return next;
                          })
                        }
                        className="h-3 w-3 accent-[var(--color-accent)]"
                      />
                      {flavor.name}
                      {flavor.existing_variant_id
                        ? isUnnamed(flavor.existing_variant_id)
                          ? " · your current item, gets this name"
                          : " · already have"
                        : ""}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {newFlavors.length > 0 ? (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                New flavors are added without a barcode or price — fill those in on the Variants tab
                before sending to the registers.
              </p>
            ) : null}
          </div>

          {draft.sources.length > 0 ? (
            <details className="text-xs text-[var(--color-text-muted)]">
              <summary className="cursor-pointer">Where this came from</summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {draft.sources.map((source) => (
                  <li key={source} className="truncate">
                    <a href={source} target="_blank" rel="noreferrer noopener" className="underline">
                      {source}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="flex items-center gap-3 border-t border-[var(--color-border)] pt-3">
            <button
              type="button"
              onClick={apply}
              disabled={working}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
            >
              {working ? "Saving…" : "Save what's ticked"}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              disabled={working}
              className="text-sm text-[var(--color-text-muted)] underline disabled:opacity-40"
            >
              Discard this draft
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DraftRow({
  id,
  label,
  value,
  note,
  disabled,
  keep,
  setKeep,
}: {
  id: string;
  label: string;
  value: string;
  note?: string | undefined;
  disabled?: boolean;
  keep: Record<string, boolean>;
  setKeep: (update: (previous: Record<string, boolean>) => Record<string, boolean>) => void;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        disabled={disabled}
        checked={Boolean(keep[id]) && !disabled}
        onChange={() => setKeep((previous) => ({ ...previous, [id]: !previous[id] }))}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)] disabled:opacity-30"
      />
      <span className="w-28 shrink-0 text-xs text-[var(--color-text-muted)]">{label}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-xs">
        {value}
        {note ? <span className="ml-2 text-[var(--color-text-muted)]">({note})</span> : null}
      </span>
    </label>
  );
}

/** The age restriction in one line, since that is how a person checks it. */
function describeCompliance(draft: AiProductDraft): string {
  const c = draft.compliance;
  if (c.minimum_age === null) return "not age-restricted";
  const extras = [
    c.id_scan_required ? "scan ID" : null,
    c.regulated_class,
    c.contains_nicotine ? "nicotine" : null,
    c.contains_cannabinoid ? "cannabinoid" : null,
    c.is_smokable ? "smokable" : null,
  ].filter(Boolean);
  return `${c.minimum_age}+${extras.length > 0 ? ` · ${extras.join(", ")}` : ""}`;
}
