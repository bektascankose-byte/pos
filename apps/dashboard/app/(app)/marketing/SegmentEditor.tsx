"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  previewSegmentAction,
  createSegmentAction,
  updateSegmentAction,
  deleteSegmentAction,
  type SegmentFormValues,
} from "./actions";
import { unreachableReasons } from "./reasons";
import type { Segment, SegmentPreview, Category } from "@snappos/contracts";

interface ProductOption {
  product_id: string;
  product_name: string;
}

/**
 * Composing a segment, with the answer visible before it is saved.
 *
 * The preview reports two numbers because they are two different facts:
 * **matched** is how many customers fit the question, **reachable** is how
 * many of those may lawfully be mailed. Showing only the first is how
 * somebody reads "412 customers" and takes it for the size of a send.
 */
export function SegmentEditor({
  segment,
  products,
  categories,
}: {
  segment?: Segment;
  products: ProductOption[];
  categories: Category[];
}) {
  const router = useRouter();
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [values, setValues] = useState<SegmentFormValues>(() => fromDefinition(segment));
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (key: keyof SegmentFormValues, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    // The preview describes the values as they were when it ran; keeping it on
    // screen next to changed inputs would be showing an answer to a different
    // question.
    setPreview(null);
  };

  const runPreview = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await previewSegmentAction(values, "email");
      if (result.ok) setPreview(result.data);
      else setMessage({ kind: "error", text: result.error });
    });
  };

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const result = segment
        ? await updateSegmentAction(segment.id, name, description, values)
        : await createSegmentAction(name, description, values);
      if (result.ok) {
        setMessage({ kind: "success", text: "Saved." });
        router.push("/marketing/segments");
        router.refresh();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const remove = () => {
    if (!segment) return;
    setMessage(null);
    startTransition(async () => {
      const result = await deleteSegmentAction(segment.id);
      if (result.ok) {
        router.push("/marketing/segments");
        router.refresh();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-xl font-semibold">{segment ? "Edit segment" : "New segment"}</h1>
        {segment ? (
          <button
            type="button"
            disabled={pending}
            onClick={remove}
            title="A segment is a saved question, not a record — deleting it leaves sent campaigns intact."
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60"
          >
            Delete
          </button>
        ) : null}
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <Field label="Name" value={name} onChange={setName} placeholder="Vape buyers, last 30 days" />
        <Field label="Description" value={description} onChange={setDescription} />
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div>
          <h2 className="text-sm font-medium">Who&apos;s in it</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Leave anything blank to ignore it. Everything filled in has to be true.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Bought this item"
            value={values.bought_product_id ?? ""}
            onChange={(v) => set("bought_product_id", v)}
            options={[
              { value: "", label: "— any item —" },
              ...products.map((p) => ({ value: p.product_id, label: p.product_name })),
            ]}
          />
          <Select
            label="Bought from this category"
            value={values.bought_category_id ?? ""}
            onChange={(v) => set("bought_category_id", v)}
            options={[
              { value: "", label: "— any category —" },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="...within the last (days)"
            value={values.within_days ?? ""}
            onChange={(v) => set("within_days", v)}
            placeholder="30"
            hint="Blank means ever."
          />
          <Field
            label="Hasn't bought anything for (days)"
            value={values.not_seen_days ?? ""}
            onChange={(v) => set("not_seen_days", v)}
            placeholder="90"
            hint="The win-back question."
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Spent at least ($)"
            value={values.min_lifetime_spend ?? ""}
            onChange={(v) => set("min_lifetime_spend", v)}
            placeholder="200"
            hint="Lifetime, net of refunds."
          />
          <Field
            label="At least this many visits"
            value={values.min_visits ?? ""}
            onChange={(v) => set("min_visits", v)}
            placeholder="3"
          />
          <Field label="Has tag" value={values.has_tag ?? ""} onChange={(v) => set("has_tag", v)} placeholder="vip" />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={runPreview}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
        >
          {pending ? "Counting..." : "Count who this reaches"}
        </button>
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={save}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
        >
          {segment ? "Save segment" : "Create segment"}
        </button>
      </div>

      {preview ? <PreviewPanel preview={preview} /> : null}
    </div>
  );
}

function PreviewPanel({ preview }: { preview: SegmentPreview }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap gap-6">
        <Stat label="Match this segment" value={preview.matched} />
        <Stat label="Can be emailed" value={preview.reachable} tone="good" />
      </div>

      {preview.matched > preview.reachable ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {preview.matched - preview.reachable} of them won&apos;t be emailed: {unreachableReasons(preview)}.
        </p>
      ) : null}

      {preview.sample.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-1.5 font-normal">Customer</th>
                <th className="px-3 py-1.5 font-normal">Email</th>
                <th className="px-3 py-1.5 font-normal">Will be emailed</th>
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((row) => (
                <tr key={row.id} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-1.5">{row.name}</td>
                  <td className="px-3 py-1.5">{row.address ?? "—"}</td>
                  <td className="px-3 py-1.5">
                    {row.reachable ? (
                      <span className="text-[var(--color-success)]">Yes</span>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">No — {row.reason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function fromDefinition(segment?: Segment): SegmentFormValues {
  const d = segment?.definition;
  if (!d) return {};
  const minor = d.min_lifetime_spend_minor;
  return {
    ...(d.bought_product_id ? { bought_product_id: d.bought_product_id } : {}),
    ...(d.bought_category_id ? { bought_category_id: d.bought_category_id } : {}),
    ...(d.within_days ? { within_days: String(d.within_days) } : {}),
    ...(d.not_seen_days ? { not_seen_days: String(d.not_seen_days) } : {}),
    ...(d.min_visits ? { min_visits: String(d.min_visits) } : {}),
    ...(d.has_tag ? { has_tag: d.has_tag } : {}),
    ...(minor !== undefined
      ? { min_lifetime_spend: `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, "0")}` }
      : {}),
  };
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" }) {
  return (
    <div>
      <div className={`text-2xl tabular-nums ${tone === "good" ? "text-[var(--color-success)]" : ""}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      {hint ? <span className="text-xs text-[var(--color-text-muted)]">{hint}</span> : null}
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
