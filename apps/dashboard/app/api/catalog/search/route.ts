import { NextRequest, NextResponse } from "next/server";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * Same-origin proxy for the catalog list's live search box and its
 * refresh-after-a-bulk-action re-fetch -- same reasoning as the
 * price-categories scan route: the browser calls this, this calls the
 * server-only `apiFetch`, the httpOnly auth cookie never has to be readable
 * by client JavaScript.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const storeId = request.nextUrl.searchParams.get("store_id") ?? "";

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (storeId) params.set("store_id", storeId);

  try {
    const result = await apiFetch(`/api/v1/catalog/products?${params}`);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not load the catalog.";
    const status = e instanceof ApiError ? e.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
