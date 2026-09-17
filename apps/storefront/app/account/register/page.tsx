import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "@/components/AccountForms";
import { AuthShell } from "@/components/AuthShell";

export const metadata: Metadata = { title: "Create an account", robots: { index: false } };

export default function RegisterPage() {
  return (
    <AuthShell
      title="Create an account"
      intro={
        <p>
          See your orders in one place and check out faster. Already have one?{" "}
          <Link href="/account/sign-in" className="font-semibold text-[var(--ink)] underline underline-offset-2">
            Sign in
          </Link>
          .
        </p>
      }
    >
      <RegisterForm />
    </AuthShell>
  );
}
