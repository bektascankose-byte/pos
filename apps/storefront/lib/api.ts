import "server-only";
import { cookies, headers } from "next/headers";
import { CART_COOKIE, SESSION_COOKIE } from "./cookies";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

export class ShopApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

interface ShopFetchOptions extends RequestInit {
  /** Send the shopper's cart token. On by default; the cart is harmless to send. */
  withCart?: boolean;
  /** Send the signed-in customer's session. On by default. */
  withSession?: boolean;
}

/**
 * Call the shop API from the server.
 *
 * The shop key lives only here, in server code, and is read from the
 * environment -- it never reaches the browser. The shopper's own address and
 * user agent are passed along so the API can rate limit each shopper
 * separately rather than treating the whole website as one caller.
 */
export async function shopFetch<T>(path: string, options: ShopFetchOptions = {}): Promise<T> {
  const key = process.env.SHOP_API_KEY;
  if (!key) throw new ShopApiError(500, "misconfigured", "SHOP_API_KEY is not set on the website server.");

  const { withCart = true, withSession = true, ...init } = options;
  const jar = await cookies();
  const incoming = await headers();
  const shopperIp = incoming.get("x-forwarded-for")?.split(",")[0]?.trim() || incoming.get("x-real-ip") || "";
  const userAgent = incoming.get("user-agent") ?? "";
  const cart = withCart ? jar.get(CART_COOKIE)?.value : undefined;
  const session = withSession ? jar.get(SESSION_COOKIE)?.value : undefined;

  const response = await fetch(`${API_BASE_URL}/api/v1/shop${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      "x-shop-key": key,
      ...(shopperIp ? { "x-shopper-ip": shopperIp } : {}),
      ...(userAgent ? { "x-shopper-agent": userAgent.slice(0, 300) } : {}),
      ...(cart ? { "x-cart-token": cart } : {}),
      ...(session ? { "x-customer-session": session } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? safeJson(text) : null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string; issues?: { message?: string }[] } | null;
    const detail = problem?.issues?.map((issue) => issue.message).filter(Boolean).join("; ");
    throw new ShopApiError(response.status, problem?.code, detail || problem?.message || "Something went wrong.");
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The bytes of a product photo, for the /img route. */
export async function shopImage(id: string, size: "full" | "thumb"): Promise<Response> {
  const key = process.env.SHOP_API_KEY ?? "";
  return fetch(`${API_BASE_URL}/api/v1/shop/images/${encodeURIComponent(id)}?size=${size}`, {
    headers: { "x-shop-key": key },
    cache: "no-store",
  });
}

/** The bytes of a banner's picture or video, for the /banner route. */
export async function shopBannerMedia(id: string, kind: "image" | "mobile_image" | "video", range?: string | null): Promise<Response> {
  const key = process.env.SHOP_API_KEY ?? "";
  return fetch(`${API_BASE_URL}/api/v1/shop/banners/${encodeURIComponent(id)}/media/${kind}`, {
    headers: { "x-shop-key": key, ...(range ? { Range: range } : {}) },
    cache: "no-store",
  });
}
