import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { ImportJob } from "@snappos/contracts";

/**
 * Every import, finished or abandoned.
 *
 * An uncommitted job is not litter: it is a file someone uploaded, mapped and
 * walked away from, and being able to come back to it is the reason the whole
 * flow is three calls against a stored job rather than one upload-and-apply.
 */
export default async function ImportsPage() {
  let jobs: ImportJob[] = [];
  let error: string | null = null;
  try {
    jobs = await apiFetch<ImportJob[]>(`/api/v1/data-transfer/imports`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load imports.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Imports</h1>
        <div className="flex gap-2">
          <Link
            href="/imports/new?entity=item"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm"
          >
            Import items
          </Link>
          <Link
            href="/imports/new?entity=customer"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm"
          >
            Import customers
          </Link>
        </div>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">File</th>
              <th className="px-4 py-2 font-normal">Type</th>
              <th className="px-4 py-2 text-right font-normal">Rows</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/imports/${job.id}`} className="text-[var(--color-accent)]">
                    {job.source_filename}
                  </Link>
                </td>
                <td className="px-4 py-2">{job.entity === "customer" ? "Customers" : "Items"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{job.row_count.toLocaleString()}</td>
                <td className="px-4 py-2">
                  <span className={job.status === "committed" ? "text-[var(--color-success)]" : ""}>
                    {job.status === "committed" ? "Imported" : job.status === "validated" ? "Checked, not imported" : "Not imported"}
                  </span>
                </td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {new Date(job.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && !error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  Nothing imported yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
