import { NextResponse } from "next/server";
import { apiFetch, ApiError } from "@/lib/api";
import type { InvoiceImport } from "@snappos/contracts";

/**
 * Same-origin proxy the invoice-review page refetches from after any line
 * or page-level action succeeds. Refetching the whole import (rather than
 * hand-patching each field a given action could have changed -- status,
 * resolved_*, split counts derived from *other* lines) is what keeps this
 * page's client state provably correct instead of a second, drifting copy
 * of logic the API already owns.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await apiFetch<InvoiceImport>(`/api/v1/invoice-imports/${id}`);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not load this invoice.";
    const status = e instanceof ApiError ? e.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
