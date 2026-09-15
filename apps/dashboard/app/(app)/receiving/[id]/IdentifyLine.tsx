"use client";

import { useEffect, useState, useTransition } from "react";
import { createProductForLineAction, referenceForCodeAction } from "../actions";
import { Modal } from "../../_components/Modal";
import { LookupSelect, type LookupOption } from "../../catalog/LookupSelect";
import type { ReceivingLine, ReceivingSession } from "@snappos/contracts";

export interface PriceGroupOption extends LookupOption {
  /** The price this group's members share, in minor units, or null when they disagree. */
  price_minor: string | null;
}

/**
 * Naming a code the catalog has never seen.
 *
 * This is where most new products in a shop like this actually get created —
 * standing over a box, not sitting at the catalog screen. So it asks for the
 * least that makes an item sellable and lets the rest be filled in later.
 *
 * Choosing a price group fills the price in from that group, because that is
 * the point of a group: the items in it share a price, and a new member
 * should take it without anyone typing the number a second time. Typing a
 * price anyway overrides it — an explicit decision beats a default.
 */
export function IdentifyLine({
  sessionId,
  line,
  categories,
  brands,
  priceGroups,
  onCategoryCreated,
  onBrandCreated,
  onPriceGroupCreated,
  onClose,
  onCreated,
}: {
  sessionId: string;
  line: ReceivingLine;
  categories: LookupOption[];
  brands: LookupOption[];
  priceGroups: PriceGroupOption[];
  onCategoryCreated: (option: LookupOption) => void;
  onBrandCreated: (option: LookupOption) => void;
  onPriceGroupCreated: (option: LookupOption) => void;
  onClose: () => void;
  onCreated: (session: ReceivingSession) => void;
}) {
  const [name, setName] = useState("");
  const [variantName, setVariantName] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [priceFromGroup, setPriceFromGroup] = useState<string | null>(null);
  const [fromReference, setFromReference] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Ask the reference catalog what this code is, once, when the form opens.
  // Only ever fills blanks: `cancelled` guards the case where someone starts
  // typing before the lookup returns, which would otherwise overwrite them.
  useEffect(() => {
    let cancelled = false;
    void referenceForCodeAction(line.scanned_code).then((known) => {
      if (cancelled || !known) return;
      setFromReference(true);
      setName((current) => current || known.name);
      setPrice((current) => current || known.price);
      setCost((current) => current || known.cost);
    });
    return () => {
      cancelled = true;
    };
  }, [line.scanned_code]);

  /**
   * Picking a group fills the price box from it, visibly, rather than leaving
   * it blank and filling it in on the server — someone about to create an
   * item should see what it will be priced at before they commit to it.
   */
  const onPriceGroupPicked = (id: string) => {
    const group = priceGroups.find((option) => option.id === id);
    if (!group) {
      setPriceFromGroup(null);
      return;
    }
    if (group.price_minor === null) {
      setPriceFromGroup(`${group.name} has no single price yet — type one.`);
      return;
    }
    const major = `${BigInt(group.price_minor) / 100n}.${(BigInt(group.price_minor) % 100n)
      .toString()
      .padStart(2, "0")}`;
    setPrice(major);
    setPriceFromGroup(`Taken from ${group.name}.`);
  };

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await createProductForLineAction(sessionId, line.id, {
        name,
        variant_name: variantName,
        price,
        cost,
        brand_id: String(formData.get("brand_id") ?? ""),
        category_id: String(formData.get("category_id") ?? ""),
        price_group_id: String(formData.get("price_group_id") ?? ""),
      });
      if (result.ok) onCreated(result.data);
      else setError(result.error);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="What is this?"
      description={`Nothing in the catalog matches ${line.scanned_code}. Naming it here creates the item and puts this scan against it.`}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(new FormData(e.currentTarget));
        }}
      >
        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

        {fromReference ? (
          <p className="rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            Filled in from your old system&apos;s item file — check it before saving.
          </p>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Geek Bar Pulse X"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Flavour or size (optional)
          <input
            value={variantName}
            onChange={(e) => setVariantName(e.target.value)}
            placeholder="Miami Mint"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <LookupSelect
            kind="category"
            label="Category"
            name="category_id"
            options={categories}
            placeholder="— none —"
            onCreated={onCategoryCreated}
          />
          <LookupSelect
            kind="brand"
            label="Brand"
            name="brand_id"
            options={brands}
            placeholder="— none —"
            onCreated={onBrandCreated}
          />
        </div>

        <LookupSelect
          kind="price_group"
          label="Price group"
          name="price_group_id"
          options={priceGroups}
          placeholder="— none —"
          onCreated={onPriceGroupCreated}
          onChange={onPriceGroupPicked}
        />

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Price ($)
            <input
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setPriceFromGroup(null);
              }}
              inputMode="decimal"
              placeholder="24.99"
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm tabular-nums outline-none focus:border-[var(--color-accent)]"
            />
            {priceFromGroup ? (
              <span className="text-xs text-[var(--color-text-muted)]">{priceFromGroup}</span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Unit cost ($)
            <input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              placeholder="9.85"
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm tabular-nums outline-none focus:border-[var(--color-accent)]"
            />
          </label>
        </div>

        <p className="text-xs text-[var(--color-text-muted)]">
          <span className="font-mono">{line.scanned_code}</span> becomes its UPC and its scannable
          barcode.
        </p>

        <div className="mt-1 flex gap-2">
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
          >
            {pending ? "Creating..." : "Create and match"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
