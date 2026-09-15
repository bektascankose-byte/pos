import { getSession } from "@/lib/session";
import { logoutAction } from "../login/actions";
import { AppNav } from "./_components/AppNav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <div className="flex min-h-screen">
      <AppNav />
      {/*
        `min-w-0` is load-bearing. A flex item defaults to `min-width: auto`,
        which refuses to shrink below its content's minimum — so one wide
        table pushed this whole column past the viewport and the *document*
        scrolled sideways, taking the sidebar with it and leaving anything
        sticky misaligned. With it, wide content scrolls inside its own
        `overflow-x-auto` box, which is what that box is for.
      */}
      <div className="flex min-w-0 flex-1 flex-col">
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
