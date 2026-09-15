"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { setMappingAction, dryRunAction, commitImportAction } from "../actions";
import type { ImportJob, ImportCommitResult } from "@snappos/contracts";

/** Preferred order for the dry-run preview's columns, most decision-relevant first. */
const SAMPLE_COLUMN_ORDER = [
  "action",
  "sku",
  "name",
  "variant",
  "brand",
  "category",
  "price",
  "cost",
  "case_cost",
  "units_per_case",
  "phone",
  "email",
  "birthday",
  "tags",
];

/**
 * The screen that stands between a spreadsheet and the catalog.
 *
 * Three steps, in order, and the order is the safety: confirm which column is
 * which, see what the import would do, then do it. The commit button is
 * disabled until a dry run has been seen — the API refuses it anyway, but a
 * button that explains itself beats an error after the click.
 */
export function ImportReviewClient({ importId, initialJob }: { importId: string; initialJob: ImportJob }) {
  const [job, setJob] = useState(initialJob);
  const [mapping, setMapping] = useState<Record<string, string>>(initialJob.mapping);
  const [remember, setRemember] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const fields = job.fields ?? [];
  const noun = job.entity === "customer" ? "customers" : "items";
  const committed = job.status === "committed";
  const dryRun = job.dry_run;
  // Only a dry run of the mapping currently on screen counts. Editing the
  // dropdowns after checking would otherwise leave a stale set of counts
  // sitting above a commit button that no longer matches them.
  const mappingSaved = JSON.stringify(mapping) === JSON.stringify(job.mapping);
  const canCommit = !committed && job.status === "validated" && mappingSaved;

  const run = <T,>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, onOk: (data: T) => void) => {
    setMessage(null);
    startTransition(async () => {
      const outcome = await action();
      if (outcome.ok) onOk(outcome.data);
      else setMessage({ kind: "error", text: outcome.error });
    });
  };

  const saveMapping = () =>
    run(
      () => setMappingAction(importId, mapping, remember),
      (updated) => {
        setJob(updated);
        setMapping(updated.mapping);
        setMessage({ kind: "success", text: "Mapping saved. Check the file next." });
      },
    );

  const check = () =>
    run(
      async () => {
        // Save first when the dropdowns have moved, so a dry run is never
        // run against a mapping the person is no longer looking at.
        if (!mappingSaved) {
          const saved = await setMappingAction(importId, mapping, remember);
          if (!saved.ok) return saved;
        }
        return dryRunAction(importId);
      },
      (updated) => {
        setJob(updated);
        setMapping(updated.mapping);
      },
    );

  const commit = () =>
    run(
      () => commitImportAction(importId),
      (outcome) => {
        setResult(outcome);
        setJob({ ...job, status: "committed" });
        setMessage({
          kind: "success",
          text: `Done. ${outcome.created} created, ${outcome.updated} updated, ${outcome.skipped} skipped.`,
        });
      },
    );

  /** A column already spoken for by another field, so one column can't fill two. */
  const takenBy = (column: string, field: string) =>
    Object.entries(mapping).find(([key, value]) => value === column && key !== field)?.[0];

  // The preview's own column order. Not `Object.keys`, because these rows
  // made a round trip through a jsonb column, and jsonb does not preserve key
  // order -- which put "action", the one column a reviewer looks at first,
  // somewhere in the middle. Anything not named here is appended, so a field
  // added later still shows up.
  const sampleRow = dryRun?.sample[0];
  const sampleColumns = sampleRow
    ? [
        ...SAMPLE_COLUMN_ORDER.filter((key) => key in sampleRow),
        ...Object.keys(sampleRow).filter((key) => !SAMPLE_COLUMN_ORDER.includes(key)),
      ]
    : [];

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{job.source_filename}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Importing {noun} · {job.row_count.toLocaleString()} rows ·{" "}
          <span className="uppercase">{job.source_format}</span> ·{" "}
          <span className="capitalize">{job.status}</span>
        </p>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      {committed ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
          <p className="font-medium">This import has been applied.</p>
          {result ? (
            <p className="mt-1 text-[var(--color-text-muted)]">
              {result.created} created, {result.updated} updated, {result.skipped} skipped.
            </p>
          ) : null}
          <Link
            href={job.entity === "customer" ? "/customers" : "/catalog"}
            className="mt-2 inline-block text-[var(--color-accent)] underline"
          >
            Go to {noun}
          </Link>
        </div>
      ) : null}

      {!committed ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-3">
            <h2 className="text-sm font-medium">1 · Which column is which</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              {job.reused_saved_mapping
                ? "This matches the layout you saved for these columns — the same mapping as last time."
                : "Matched from the column headings, with AI filling in anything unrecognized. Check it."}
            </p>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {fields.map((field) => {
              const guessed = job.ai_mapped_fields.includes(field.key);
              return (
                <div key={field.key} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                  <div className="w-44 shrink-0">
                    <span className="font-medium">{field.label}</span>
                    {field.required ? <span className="ml-1 text-[var(--color-error)]">*</span> : null}
                    {guessed ? (
                      <span className="ml-2 rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-xs text-[var(--color-accent)]">
                        AI guess
                      </span>
                    ) : null}
                  </div>
                  <select
                    value={mapping[field.key] ?? ""}
                    onChange={(e) => {
                      const next = { ...mapping };
                      if (e.target.value) next[field.key] = e.target.value;
                      else delete next[field.key];
                      setMapping(next);
                    }}
                    className="w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm"
                  >
                    <option value="">— not in this file —</option>
                    {job.headers.map((header) => {
                      const taken = takenBy(header, field.key);
                      return (
                        <option key={header} value={header} disabled={Boolean(taken)}>
                          {header}
                          {taken ? ` (used by ${fields.find((f) => f.key === taken)?.label ?? taken})` : ""}
                        </option>
                      );
                    })}
                  </select>
                  <span className="flex-1 text-xs text-[var(--color-text-muted)]">{field.hint}</span>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] px-4 py-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember this layout for files with the same columns
            </label>
            {/* Enabled when the layout is being remembered even if the mapping
                itself hasn't moved: a proposal that was right first time is
                exactly the one most worth saving, and disabling this on
                "nothing changed" made that impossible. */}
            <button
              type="button"
              disabled={pending || (mappingSaved && !remember)}
              onClick={saveMapping}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {remember ? "Save and remember" : mappingSaved ? "Mapping saved" : "Save mapping"}
            </button>
          </div>
        </section>
      ) : null}

      {!committed ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-medium">2 · What this would do</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Checks every row against the catalog. Writes nothing.
              </p>
            </div>
            <button
              type="button"
              disabled={pending || !mapping.sku && job.entity === "item"}
              onClick={check}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-40"
              title={job.entity === "item" && !mapping.sku ? "Map the SKU column first" : undefined}
            >
              {pending ? "Checking..." : dryRun ? "Check again" : "Check this file"}
            </button>
          </div>

          {dryRun ? (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap gap-6 text-sm">
                <Stat label="Will create" value={dryRun.create_count} tone="good" />
                <Stat label="Will update" value={dryRun.update_count} tone="good" />
                <Stat label="Will skip" value={dryRun.skip_count} tone={dryRun.skip_count > 0 ? "warn" : "plain"} />
                <Stat label="Rows in file" value={dryRun.total_rows} tone="plain" />
              </div>

              {dryRun.ignored_columns.length > 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Not importing these columns: {dryRun.ignored_columns.join(", ")}
                </p>
              ) : null}

              {(dryRun.warnings ?? []).map((warning) => (
                <p
                  key={warning}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs"
                >
                  {warning}
                </p>
              ))}

              {sampleColumns.length > 0 ? (
                <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
                  <table className="w-full text-xs">
                    <thead className="text-left text-[var(--color-text-muted)]">
                      <tr>
                        {sampleColumns.map((key) => (
                          <th key={key} className="px-3 py-1.5 font-normal">
                            {key.replace(/_/g, " ")}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dryRun!.sample.map((row, i) => (
                        <tr key={i} className="border-t border-[var(--color-border)]">
                          {sampleColumns.map((key) => (
                            <td key={key} className="px-3 py-1.5">
                              {row[key] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {dryRun.issues.length > 0 ? (
                <details open={dryRun.issues.length <= 10}>
                  <summary className="cursor-pointer text-sm text-[var(--color-text-muted)]">
                    {dryRun.skip_count} row{dryRun.skip_count === 1 ? "" : "s"} will be skipped
                    {dryRun.issues.length < dryRun.skip_count
                      ? ` (first ${dryRun.issues.length} shown)`
                      : ""}
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {dryRun.issues.map((issue) => (
                      <li key={`${issue.row_number}-${issue.message}`} className="text-[var(--color-text-muted)]">
                        <span className="font-mono">Row {issue.row_number}</span>
                        {issue.identifier ? ` (${issue.identifier})` : ""} — {issue.message}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : (
            <p className="p-4 text-sm text-[var(--color-text-muted)]">
              Nothing has been checked yet.
            </p>
          )}
        </section>
      ) : null}

      {!committed ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-medium">3 · Import</h2>
          <p className="mb-3 text-xs text-[var(--color-text-muted)]">
            {canCommit
              ? `${dryRun!.create_count + dryRun!.update_count} ${noun} will be written. This can't be undone in one click — items can be archived afterwards, and prices keep their history.`
              : mappingSaved
                ? "Check the file first."
                : "Save the mapping and check the file first."}
          </p>
          <button
            type="button"
            disabled={pending || !canCommit}
            onClick={commit}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Importing..." : `Import ${noun}`}
          </button>
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "good" | "warn" | "plain" }) {
  const color =
    tone === "good" ? "text-[var(--color-success)]" : tone === "warn" ? "text-[var(--color-error)]" : "";
  return (
    <div>
      <div className={`text-2xl tabular-nums ${color}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}
