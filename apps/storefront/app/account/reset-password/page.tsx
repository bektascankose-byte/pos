import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/AccountForms";
import { AuthShell } from "@/components/AuthShell";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false, follow: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthShell title="Choose a new password" intro={<p>Choosing a new password signs you out on every other device.</p>}>
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p className="text-sm">
          This link is missing something.{" "}
          <Link href="/account/forgot-password" className="underline underline-offset-2">
            Ask for a new one
          </Link>
          .
        </p>
      )}
    </AuthShell>
  );
}
