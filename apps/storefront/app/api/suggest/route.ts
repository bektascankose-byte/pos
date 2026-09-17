import type { ShopSuggestion } from "@snappos/contracts";
import { shopFetch } from "@/lib/api";

/** Search suggestions for the header's search box. The shop key stays on the server. */
export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 100);
  if (q.trim().length < 2) return Response.json([]);
  try {
    const suggestions = await shopFetch<ShopSuggestion[]>(`/suggest?q=${encodeURIComponent(q)}`, {
      withCart: false,
      withSession: false,
    });
    return Response.json(suggestions, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch {
    return Response.json([]);
  }
}
