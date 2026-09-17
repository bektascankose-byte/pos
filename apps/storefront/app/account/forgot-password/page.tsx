import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/AccountForms";
import { AuthShell } from "@/components/AuthShell";

export const metadata: Metadata = { title: "Reset your password", robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Reset your password" intro={<p>Enter your email and we&apos;ll send a link to choose a new one.</p>}>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
