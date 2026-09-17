import { shopBannerMedia } from "@/lib/api";

const KINDS = new Set(["image", "mobile_image", "video"]);

/**
 * Banner artwork, served from this site's own origin.
 *
 * Same shape as `/img`: the bucket is private and the API only hands the bytes
 * to a caller holding the shop key, so the browser cannot reach them directly.
 * Range requests are passed through because a browser asks for video a piece
 * at a time and will not play one that arrives any other way.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !KINDS.has(kind)) return new Response("Not found", { status: 404 });

  const upstream = await shopBannerMedia(id, kind as "image" | "mobile_image" | "video", request.headers.get("range"));
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
    // A banner's bytes never change: replacing the picture makes a new banner.
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  for (const header of ["content-range", "accept-ranges", "content-length"]) {
    const value = upstream.headers.get(header);
    if (value) headers.set(header, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
