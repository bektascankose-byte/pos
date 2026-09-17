/** The narrow single-column frame every sign-in style page shares. */
export function AuthShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="display text-4xl font-extrabold uppercase">{title}</h1>
        {intro ? <div className="text-[var(--muted)]">{intro}</div> : null}
      </div>
      <div className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6">{children}</div>
    </div>
  );
}
