import type { Metadata } from "next";
import Link from "next/link";
import { getShopInfo } from "@/lib/shop";
import { confirmAgeAction } from "./actions";

export const metadata: Metadata = { title: "Are you 21 or older?", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AgeCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; under?: string }>;
}) {
  const { next, under } = await searchParams;
  const info = await getShopInfo();

  if (under) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 py-10 text-center">
        <h1 className="display text-4xl font-extrabold uppercase">Sorry, not yet</h1>
        <p className="text-[var(--muted)]">
          This shop sells products for adults 21 and older, so we can&apos;t let you in.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 py-10 text-center">
      <p className="eyebrow">{info?.shop_name ?? "Welcome"}</p>
      <h1 className="display text-5xl font-extrabold uppercase">Are you 21 or older?</h1>
      <p className="text-[var(--muted)]">
        This site sells nicotine and other products for adults only. We check photo ID when every order is picked up.
      </p>
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
        <form action={confirmAgeAction}>
          <input type="hidden" name="next" value={next ?? "/"} />
          <button type="submit" className="btn btn-primary w-full px-10 sm:w-auto">
            Yes, I&apos;m 21 or older
          </button>
        </form>
        <Link href="/age-check?under=1" className="btn btn-quiet px-10">
          No
        </Link>
      </div>
      <p className="text-xs text-[var(--muted)]">
        Answering here doesn&apos;t verify your age. See our{" "}
        <Link href="/legal/age-policy" className="underline underline-offset-2">
          age policy
        </Link>
        .
      </p>
    </div>
  );
}
