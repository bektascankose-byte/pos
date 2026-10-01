import { NextResponse } from "next/server";
import { apiFetchRaw } from "@/lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Same-origin source for a brand logo, for the same reason the product photo
 * route is one: the access token lives in an httpOnly cookie, so an `<img>`
 * pointed straight at the API would arrive unauthenticated.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "No logo by that id." }, { status: 404 });
  }

  const response = await apiFetchRaw(`/api/v1/catalog/brand-logos/${id}`);
  if (!response.ok) {
    return NextResponse.json({ error: "Could not load that logo." }, { status: response.status });
  }

  return new NextResponse(response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "image/png",
      // A replaced logo is a new row with a new id, so this one never changes.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
