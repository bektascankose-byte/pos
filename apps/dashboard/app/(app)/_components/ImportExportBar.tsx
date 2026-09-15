import Link from "next/link";

/**
 * Import and export, on the list of the thing being imported or exported.
 *
 * Export is a plain link rather than a fetch: the file comes back with its
 * own `Content-Disposition`, and letting the browser follow a link is what
 * makes it save the file with the right name. It goes through this app's own
 * `/api/exports/...` proxy because the access token is in an httpOnly cookie
 * that page JavaScript deliberately cannot read.
 *
 * The current search and archived filter ride along, so what you export is
 * what you are looking at.
 */
export function ImportExportBar({
  entity,
  query,
  status,
}: {
  entity: "item" | "customer";
  query?: string | undefined;
  status?: string | undefined;
}) {
  const path = entity === "customer" ? "customers" : "items";
  const filters = new URLSearchParams();
  if (query) filters.set("q", query);
  if (status) filters.set("status", status);
  const suffix = filters.toString() ? `&${filters}` : "";

  const linkClass =
    "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm";

  return (
    <div className="flex items-center gap-2">
      <Link href={`/imports/new?entity=${entity}`} className={linkClass}>
        Import
      </Link>
      <a href={`/api/exports/${path}?format=csv${suffix}`} className={linkClass} download>
        Export CSV
      </a>
      <a href={`/api/exports/${path}?format=xlsx${suffix}`} className={linkClass} download>
        Excel
      </a>
    </div>
  );
}
