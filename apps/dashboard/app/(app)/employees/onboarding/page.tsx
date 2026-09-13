import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { createTemplateItemAction, updateTemplateItemAction } from "../actions";
import type { OnboardingTaskTemplate } from "@snappos/contracts";

export default async function OnboardingTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { saved, error } = await searchParams;

  let items: OnboardingTaskTemplate[] = [];
  let loadError: string | null = null;
  try {
    items = await apiFetch<OnboardingTaskTemplate[]>(`/api/v1/onboarding/templates`);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load the onboarding checklist template.";
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <Link href="/employees" className="text-sm underline">
          ← back to employees
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Onboarding checklist template</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Every new employee automatically gets a checklist with a copy of whatever tasks are active
          here at the moment they're hired. Editing a task afterward only changes what future hires
          see -- it never rewrites a checklist someone is already partway through.
        </p>
      </div>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}

      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const updateItem = updateTemplateItemAction.bind(null, item.id);
          return (
            <form
              key={item.id}
              action={updateItem}
              className={`flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${
                item.is_active ? "" : "opacity-60"
              }`}
            >
              <input
                name="title"
                defaultValue={item.title}
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-medium outline-none focus:border-[var(--color-accent)]"
              />
              <textarea
                name="description"
                defaultValue={item.description ?? ""}
                placeholder="Optional details"
                rows={2}
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                  <input type="checkbox" name="is_active" defaultChecked={item.is_active} />
                  Active (included for new hires)
                </label>
                <button
                  type="submit"
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 text-sm"
                >
                  Save
                </button>
              </div>
            </form>
          );
        })}
        {items.length === 0 && !loadError ? (
          <p className="text-sm text-[var(--color-text-muted)]">No tasks yet -- add the first one below.</p>
        ) : null}
      </div>

      <form
        action={createTemplateItemAction}
        className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <h2 className="text-sm font-medium text-[var(--color-text-muted)]">Add a task</h2>
        <input
          name="title"
          placeholder="e.g. Sign employee handbook"
          required
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <textarea
          name="description"
          placeholder="Optional details"
          rows={2}
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Add task
        </button>
      </form>
    </div>
  );
}
