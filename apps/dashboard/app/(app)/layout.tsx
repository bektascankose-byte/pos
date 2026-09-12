import Link from "next/link";
import { getSession } from "@/lib/session";
import { logoutAction } from "../login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="mb-6 text-lg font-semibold">SnapPOS</div>
        <nav className="flex flex-col gap-1 text-sm">
          <Link href="/" className="rounded-md px-3 py-2 hover:bg-[var(--color-bg)]">
            Dashboard
          </Link>
          <Link href="/customers" className="rounded-md px-3 py-2 hover:bg-[var(--color-bg)]">
            Customers
          </Link>
        </nav>
      </aside>
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
