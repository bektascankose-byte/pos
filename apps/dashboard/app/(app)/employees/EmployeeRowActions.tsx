"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../_components/Modal";
import { removeEmployeeAction, updateEmployeeAction } from "./actions";

export function EmployeeRowActions({
  id,
  name,
  removed,
  canRemove,
}: {
  id: string;
  name: string;
  removed: boolean;
  canRemove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const restore = () => {
    const data = new FormData();
    data.set("status", "active");
    setError(null);
    startTransition(async () => {
      const result = await updateEmployeeAction(id, data);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await removeEmployeeAction(id);
      if (result.ok) {
        setOpen(false);
        router.refresh();
      } else setError(result.error);
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 whitespace-nowrap">
      <Link href={`/employees/${id}#details`} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)]">
        Edit
      </Link>
      {removed ? (
        <button type="button" disabled={pending} onClick={restore} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-60">
          {pending ? "Restoring…" : "Restore"}
        </button>
      ) : canRemove ? (
        <button type="button" disabled={pending} onClick={() => setOpen(true)} className="rounded-md border border-[var(--color-error)]/35 px-3 py-1.5 text-xs font-medium text-[var(--color-error)] disabled:opacity-60">
          Remove
        </button>
      ) : null}
      {error && !open ? <span role="alert" className="w-full text-xs text-[var(--color-error)]">{error}</span> : null}
      <Modal open={open} onClose={() => !pending && setOpen(false)} title={`Remove ${name}?`} description="This removes the employee from the active roster and prevents new sign-ins. Their past sales and time records remain available.">
        {error ? <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={pending} onClick={() => setOpen(false)} className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm">Keep employee</button>
          <button type="button" disabled={pending} onClick={remove} className="rounded-md bg-[var(--color-error)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{pending ? "Removing…" : "Remove employee"}</button>
        </div>
      </Modal>
    </div>
  );
}
