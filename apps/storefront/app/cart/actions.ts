"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { ShopCart, ShopCartCreated } from "@snappos/contracts";
import { ShopApiError, shopFetch } from "@/lib/api";
import { CART_COOKIE, cookieOptions, THIRTY_DAYS } from "@/lib/cookies";

export type CartResult = { ok: true; cart: ShopCart } | { ok: false; error: string };

async function startCart(): Promise<string> {
  const created = await shopFetch<ShopCartCreated>("/cart", { method: "POST", withCart: false });
  (await cookies()).set(CART_COOKIE, created.cart_token, { ...cookieOptions, maxAge: THIRTY_DAYS });
  return created.cart_token;
}

/**
 * Run a cart change, starting a cart if the shopper has none, and starting a
 * fresh one if theirs has expired or already became an order.
 */
async function withCart(change: (token: string) => Promise<ShopCart>): Promise<CartResult> {
  try {
    let token = (await cookies()).get(CART_COOKIE)?.value ?? (await startCart());
    try {
      return { ok: true, cart: await change(token) };
    } catch (e) {
      if (!(e instanceof ShopApiError && e.status === 404 && /cart/i.test(e.message))) throw e;
      token = await startCart();
      return { ok: true, cart: await change(token) };
    }
  } catch (e) {
    return { ok: false, error: e instanceof ShopApiError ? e.message : "Something went wrong. Try again." };
  } finally {
    revalidatePath("/", "layout");
  }
}

export async function addToCartAction(variantId: string, quantity: number): Promise<CartResult> {
  return withCart((token) =>
    shopFetch<ShopCart>(`/cart/lines/${encodeURIComponent(variantId)}`, {
      method: "POST",
      body: JSON.stringify({ quantity }),
      headers: { "x-cart-token": token },
    }),
  );
}

export async function setQuantityAction(variantId: string, quantity: number): Promise<CartResult> {
  return withCart((token) =>
    shopFetch<ShopCart>(`/cart/lines/${encodeURIComponent(variantId)}`, {
      method: "PUT",
      body: JSON.stringify({ quantity }),
      headers: { "x-cart-token": token },
    }),
  );
}
