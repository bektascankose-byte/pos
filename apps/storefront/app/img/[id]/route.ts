import { shopImage } from "@/lib/api";

/**
 * Product photos, served from this site's own origin.
 *
 * The bucket they live in is private and the API only hands them to a caller
 * holding the shop key, so the browser cannot fetch them directly. This route
 * fetches them server-side and passes the bytes through -- only for photos of
 * items the website is allowed to show, which the API decides.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  const size = new URL(request.url).searchParams.get("size") === "full" ? "full" : "thumb";
  const upstream = await shopImage(id, size);
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      // A photo's bytes never change; a replacement gets a new id.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
