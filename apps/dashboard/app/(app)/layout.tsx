import { getSession } from "@/lib/session";
import { logoutAction } from "../login/actions";
import { AppNav } from "./_components/AppNav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <div className="bo-shell">
      <AppNav />
      <div className="bo-main-column">
        <header className="bo-topbar">
          <div>
            <div className="bo-topbar-name">Back Office</div>
            <div className="bo-topbar-sub">Your store, at a glance</div>
          </div>
          <div className="bo-topbar-user">
            <span className="bo-avatar" aria-hidden>{(session?.displayName ?? "S").slice(0, 1).toUpperCase()}</span>
            <div>
              <div className="text-xs font-bold">{session?.displayName ?? "Signed in"}</div>
              <form action={logoutAction}>
                <button type="submit" className="bo-signout">Sign out</button>
              </form>
            </div>
          </div>
        </header>
        <main className="bo-content">{children}</main>
      </div>
    </div>
  );
}
