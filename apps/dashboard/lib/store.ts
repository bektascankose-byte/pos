import "server-only";
import { apiFetch } from "./api";

interface Store {
  id: string;
  code: string;
  name: string;
}

/**
 * The org's first store. This app has no store switcher yet -- reasonable
 * while the shop this ships to first has exactly one -- so catalog pricing
 * is shown and edited against whichever store the API happens to list
 * first. Add a real selector before a second store exists.
 */
export async function primaryStoreId(): Promise<string | null> {
  const result = await apiFetch<{ data: Store[] }>("/api/v1/stores");
  return result.data[0]?.id ?? null;
}
