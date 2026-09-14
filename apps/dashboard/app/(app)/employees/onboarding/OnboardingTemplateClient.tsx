"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { createTemplateItemAction, updateTemplateItemAction } from "../actions";
import type { OnboardingTaskTemplate } from "@snappos/contracts";

export function OnboardingTemplateClient({ initialItems }: { initialItems: OnboardingTaskTemplate[] }) {
  const [items, setItems] = useState(initialItems);
  const [addError, setAddError] = useState<string | null>(null);
  const [addPending, startAddTransition] = useTransition();

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAddError(null);
    const form = e.currentTarget;
    const formData = new FormData(form);
    startAddTransition(async () => {
      const result = await createTemplateItemAction(formData);
      if (result.ok) {
        setItems((prev) => [...prev, result.data]);
        form.reset();
      } else {
        setAddError(result.error);
      }
    });
  };

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

      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <TemplateItemRow key={item.id} item={item} onSaved={(updated) => setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))} />
        ))}
        {items.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No tasks yet -- add the first one below.</p>
        ) : null}
      </div>

      {addError ? <p className="text-sm text-[var(--color-error)]">{addError}</p> : null}
      <form
        onSubmit={handleAdd}
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
          disabled={addPending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {addPending ? "Adding..." : "Add task"}
        </button>
      </form>
    </div>
  );
}

function TemplateItemRow({
  item,
  onSaved,
}: {
  item: OnboardingTaskTemplate;
  onSaved: (updated: OnboardingTaskTemplate) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await updateTemplateItemAction(item.id, formData);
      if (result.ok) {
        onSaved(result.data);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={`flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${
        item.is_active ? "" : "opacity-60"
      }`}
    >
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
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
          disabled={pending}
          className="rounded-md border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}
