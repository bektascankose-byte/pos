import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/AccountForms";
import { AuthShell } from "@/components/AuthShell";
import { getCustomer } from "@/lib/shop";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : "/account";
  if (await getCustomer()) redirect(safe);

  return (
    <AuthShell
      title="Sign in"
      intro={
        <p>
          New here?{" "}
          <Link href="/account/register" className="font-semibold text-[var(--ink)] underline underline-offset-2">
            Create an account
          </Link>
          . You can also check out as a guest.
        </p>
      }
    >
      <SignInForm next={safe} />
    </AuthShell>
  );
}
