"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ShopPlacedOrder } from "@snappos/contracts";
import { ShopApiError, shopFetch } from "@/lib/api";
import { CART_COOKIE, SESSION_COOKIE } from "@/lib/cookies";

export interface CheckoutState {
  error: string | null;
  fields: Record<string, string>;
}

/**
 * Place the order.
 *
 * Safe to submit twice: the API turns a cart into an order once, and hands the
 * same order back to a second submission of the same cart. So a shopper who
 * double-clicks, or refreshes while it is working, lands on the same order.
 */
export async function placeOrderAction(_previous: CheckoutState, form: FormData): Promise<CheckoutState> {
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const fields = {
    first_name: field("first_name"),
    last_name: field("last_name"),
    email: field("email"),
    phone: field("phone"),
    note: field("note"),
  };
  const jar = await cookies();
  const signedIn = Boolean(jar.get(SESSION_COOKIE)?.value);

  if (form.get("age_attested") !== "yes") {
    return { error: "Confirm that you are 21 or older to place an order.", fields };
  }
  if (!signedIn && (!fields.first_name || !fields.last_name || !fields.email)) {
    return { error: "Add your name and email so we can tell you when it's ready.", fields };
  }

  let placed: ShopPlacedOrder;
  try {
    placed = await shopFetch<ShopPlacedOrder>("/checkout", {
      method: "POST",
      body: JSON.stringify({
        ...(signedIn
          ? {}
          : {
              contact: {
                first_name: fields.first_name,
                last_name: fields.last_name,
                email: fields.email,
                ...(fields.phone ? { phone: fields.phone } : {}),
              },
            }),
        ...(fields.note ? { note: fields.note } : {}),
        age_attested: true,
      }),
    });
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 404) {
      return { error: "Your cart has expired. Add your items again and check out.", fields };
    }
    return { error: e instanceof ShopApiError ? e.message : "The order didn't go through. Try again.", fields };
  }

  // The cart became this order. Forget it, so the next visit starts a new one.
  jar.delete(CART_COOKIE);
  revalidatePath("/", "layout");
  redirect(`/track/${placed.tracking_token}?placed=1`);
}
