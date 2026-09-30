import { getSession } from "@/lib/session";
import { ThemeToggle } from "@/app/_components/ThemeToggle";
import { logoutAction } from "../login/actions";
import { AppNav } from "./_components/AppNav";
import { Crumbs } from "./_components/Crumbs";
import { TopbarSearch } from "./_components/TopbarSearch";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const name = session?.displayName ?? "Signed in";

  return (
    <div className="bo-shell">
      <AppNav />
      <div className="bo-main-column">
        <header className="bo-topbar">
          <Crumbs />
          <div className="bo-topbar-tools">
            <TopbarSearch />
            <ThemeToggle />
            <div className="bo-user">
              <span className="bo-avatar" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>
              <div className="bo-user-meta">
                <div className="bo-user-name">{name}</div>
                <form action={logoutAction}>
                  <button type="submit" className="bo-signout">Sign out</button>
                </form>
              </div>
            </div>
          </div>
        </header>
        <main className="bo-content">{children}</main>
      </div>
    </div>
  );
}
