import { getSession } from "@/lib/session";
import { logoutAction } from "../login/actions";
import { AppNav } from "./_components/AppNav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <div className="flex min-h-screen">
      <AppNav />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-3">
          <div className="text-sm text-[var(--color-text-muted)]">
            {session?.displayName ?? "Signed in"}
          </div>
          <form action={logoutAction}>
            <button type="submit" className="text-sm text-[var(--color-accent)]">
              Sign out
            </button>
          </form>
        </header>
        <main className="flex-1 bg-[var(--color-bg)] p-6">{children}</main>
      </div>
    </div>
  );
}
