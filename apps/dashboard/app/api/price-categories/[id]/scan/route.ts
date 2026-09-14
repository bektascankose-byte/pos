import { NextResponse } from "next/server";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * The only same-origin proxy in this app -- exists so the price category
 * detail page's speed-scan box can progressively enhance a real form with a
 * bit of page-local JavaScript without a full page reload per scan, while
 * auth and business logic stay exactly where every other mutation already
 * puts them: server-side, through the same `apiFetch` a Server Action uses.
 * The browser never talks to the API directly.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "No code given." }, { status: 400 });
  }

  try {
    const result = await apiFetch(`/api/v1/catalog/price-categories/${id}/scan`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that item.";
    const status = e instanceof ApiError ? e.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
