import { NextResponse } from "next/server";
import { apiFetchRaw } from "@/lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Same-origin source for a product photo.
 *
 * A proxy for the same reason the export download is one: the access token
 * lives in an httpOnly cookie this app never exposes to browser JavaScript, so
 * an `<img src>` pointed straight at the API would arrive unauthenticated.
 *
 * The id is checked against the uuid shape before it is forwarded. The API
 * would reject anything else anyway, but a path segment taken from a URL and
 * pasted into another URL is worth narrowing where it is read, not only where
 * it is used.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "No image by that id." }, { status: 404 });
  }

  const size = new URL(request.url).searchParams.get("size") === "thumb" ? "thumb" : "full";
  const response = await apiFetchRaw(`/api/v1/catalog/images/${id}?size=${size}`);

  if (!response.ok) {
    return NextResponse.json({ error: "Could not load that image." }, { status: response.status });
  }

  return new NextResponse(response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "image/jpeg",
      // An image row's bytes never change — replacing a photo makes a new row
      // with a new id — so the browser may keep this indefinitely.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
