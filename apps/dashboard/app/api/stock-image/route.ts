import { NextResponse } from "next/server";
import { apiFetchRaw } from "@/lib/api";

/**
 * Same-origin source for a stock photo the AI found.
 *
 * A proxy for two reasons. The access token lives in an httpOnly cookie, as
 * with the product-image proxy next door — but the reason this one has to
 * exist at all is the canvas. The browser downscales every product photo
 * before uploading it (see `ImagePanel`), and drawing a cross-origin image to
 * a canvas taints it, so `toBlob` throws and the photo cannot be scaled. Bytes
 * arriving from this app's own origin are not tainted, so the same downscaler
 * works on a found photo as on one picked off a phone.
 *
 * The address is not inspected here. Where it may point is decided in the
 * API's `StockImageService`, which is the one place that has to get it right
 * and the one place with tests for it.
 */
export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "No address given." }, { status: 400 });
  }

  const response = await apiFetchRaw(
    `/api/v1/catalog/images/stock?url=${encodeURIComponent(url)}`,
  );

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return NextResponse.json(
      { error: body?.user_message ?? body?.message ?? "Could not fetch that photo." },
      { status: response.status },
    );
  }

  return new NextResponse(response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "image/jpeg",
      // Somebody else's image at an address nobody owns. The copy worth
      // keeping is the one that gets uploaded.
      "cache-control": "no-store",
    },
  });
}
