import type { Metadata } from "next";
import Link from "next/link";
import { VerifyEmailForm } from "@/components/AccountForms";
import { AuthShell } from "@/components/AuthShell";

export const metadata: Metadata = { title: "Confirm your email", robots: { index: false, follow: false } };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthShell title="Confirm your email" intro={<p>One more step and your account is ready.</p>}>
      {token ? (
        <VerifyEmailForm token={token} />
      ) : (
        <p className="text-sm">
          This link is missing something. Open the link from your email again, or{" "}
          <Link href="/account/sign-in" className="underline underline-offset-2">
            sign in
          </Link>{" "}
          to be sent a new one.
        </p>
      )}
    </AuthShell>
  );
}
