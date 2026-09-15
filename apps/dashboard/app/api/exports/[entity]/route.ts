import { NextResponse } from "next/server";
import { apiFetchRaw } from "@/lib/api";

const ENTITIES = new Set(["items", "customers"]);
const FORMATS = new Set(["csv", "xlsx"]);

/**
 * Same-origin download for an export.
 *
 * It has to be a proxy rather than a link straight at the API: the access
 * token lives in an httpOnly cookie this app deliberately never exposes to
 * browser JavaScript, so nothing in the page can attach it. The file's own
 * `Content-Disposition` is passed through unchanged, which is what makes the
 * browser save it with the right name instead of rendering it.
 *
 * Only the filters this understands are forwarded. Reflecting the caller's
 * whole query string would let a crafted link reach query parameters the
 * export endpoint never meant to take from a user.
 */
export async function GET(request: Request, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  if (!ENTITIES.has(entity)) {
    return NextResponse.json({ error: "Nothing to export by that name." }, { status: 404 });
  }

  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  const format = incoming.get("format") ?? "csv";
  query.set("format", FORMATS.has(format) ? format : "csv");
  const q = incoming.get("q");
  if (q) query.set("q", q);
  const status = incoming.get("status");
  if (status) query.set("status", status);

  const response = await apiFetchRaw(`/api/v1/data-transfer/exports/${entity}?${query}`);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return NextResponse.json(
      { error: body?.user_message ?? body?.message ?? "Could not build that export." },
      { status: response.status },
    );
  }

  return new NextResponse(response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": response.headers.get("content-disposition") ?? `attachment; filename="${entity}.csv"`,
      "cache-control": "no-store",
    },
  });
}
