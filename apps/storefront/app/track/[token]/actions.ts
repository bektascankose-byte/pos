"use server";

import { revalidatePath } from "next/cache";
import { ShopApiError, shopFetch } from "@/lib/api";

export interface CancelState {
  error: string | null;
}

export async function cancelOrderAction(token: string, _previous: CancelState): Promise<CancelState> {
  try {
    await shopFetch(`/orders/track/${encodeURIComponent(token)}/cancel`, { method: "POST", withCart: false });
  } catch (e) {
    return { error: e instanceof ShopApiError ? e.message : "The order couldn't be cancelled. Call the shop." };
  }
  revalidatePath(`/track/${token}`);
  return { error: null };
}
