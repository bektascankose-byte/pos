import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type { BannerPlacement, ShopBanner, ShopCart, ShopCategory, ShopCustomerProfile, ShopInfo } from "@snappos/contracts";
import { CART_COOKIE, SESSION_COOKIE } from "./cookies";
import { ShopApiError, shopFetch } from "./api";

/** Shop name, store address and hours. Asked once per page render, however many components need it. */
export const getShopInfo = cache(async (): Promise<ShopInfo | null> => {
  try {
    return await shopFetch<ShopInfo>("/info", { withCart: false, withSession: false });
  } catch {
    return null;
  }
});

export const getCategories = cache(async (): Promise<ShopCategory[]> => {
  try {
    return await shopFetch<ShopCategory[]>("/categories", { withCart: false, withSession: false });
  } catch {
    return [];
  }
});

/** The shopper's cart, or null if they have none yet (or it expired). */
export const getCart = cache(async (): Promise<ShopCart | null> => {
  const jar = await cookies();
  if (!jar.get(CART_COOKIE)?.value) return null;
  try {
    return await shopFetch<ShopCart>("/cart");
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 404) return null;
    throw e;
  }
});

/** The signed-in customer, or null. An expired session reads as signed out. */
export const getCustomer = cache(async (): Promise<ShopCustomerProfile | null> => {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)?.value) return null;
  try {
    return await shopFetch<ShopCustomerProfile>("/account/me", { withCart: false });
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 401) return null;
    throw e;
  }
});

/**
 * The banners showing in one place on the page.
 *
 * Never throws: artwork is decoration, and a shop whose banner service is
 * having a bad afternoon should still be able to sell. The page renders
 * without it.
 */
export const getBanners = cache(async (placement: BannerPlacement, brandId?: string): Promise<ShopBanner[]> => {
  const query = new URLSearchParams({ placement });
  if (brandId) query.set("brand", brandId);
  try {
    return await shopFetch<ShopBanner[]>(`/banners?${query}`, { withCart: false, withSession: false });
  } catch {
    return [];
  }
});
