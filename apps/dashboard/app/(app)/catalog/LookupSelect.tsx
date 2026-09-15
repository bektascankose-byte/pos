"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createLookupAction } from "./actions";
import { Modal } from "../_components/Modal";

export interface LookupOption {
  id: string;
  name: string;
}

/** The sentinel option value. Not a uuid, so it can never collide with a real id. */
const ADD_NEW = "__add_new__";

/**
 * A dropdown that can create the thing it's choosing from.
 *
 * The problem this solves is small and constant: someone is bulk-tagging
 * twenty items, realizes the category doesn't exist yet, and has to leave the
 * page — losing the twenty checkboxes they just ticked — to go and make it.
 *
 * Picking "+ Add new" opens a dialog and **immediately puts the select back**
 * to what it was. If that reset didn't happen, cancelling the dialog would
 * leave the sentinel selected, and the form would post `__add_new__` as if it
 * were an id.
 */
export function LookupSelect({
  kind,
  label,
  name,
  options,
  onCreated,
  placeholder = "Unchanged",
  defaultValue = "",
}: {
  kind: "category" | "brand" | "price_group";
  label: string;
  name: string;
  options: LookupOption[];
  onCreated: (option: LookupOption) => void;
  placeholder?: string;
  defaultValue?: string;
}) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const previous = useRef(defaultValue);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Spelled out rather than `${noun}s`, which produced "categorys".
  const noun = kind === "price_group" ? "price group" : kind;
  const plural = kind === "category" ? "categories" : `${noun}s`;

  const close = () => {
    setAdding(false);
    setNewName("");
    setError(null);
  };

  /**
   * The id to select once its `<option>` actually exists.
   *
   * Setting `select.value` straight after `onCreated` silently does nothing:
   * `onCreated` only schedules the parent's state update, so at that moment
   * the option isn't in the DOM and assigning an unknown value leaves the
   * select on its placeholder. The effect below runs after the re-render that
   * adds it.
   */
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingSelection || !selectRef.current) return;
    const exists = Array.from(selectRef.current.options).some((o) => o.value === pendingSelection);
    if (!exists) return;
    selectRef.current.value = pendingSelection;
    previous.current = pendingSelection;
    setPendingSelection(null);
  }, [pendingSelection, options]);

  const create = () => {
    setError(null);
    startTransition(async () => {
      const result = await createLookupAction(kind, newName);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated(result.data);
      // Creating it from here means you want it selected.
      setPendingSelection(result.data.id);
      close();
    });
  };

  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        {label}
        <select
          ref={selectRef}
          name={name}
          defaultValue={defaultValue}
          onChange={(e) => {
            if (e.target.value !== ADD_NEW) {
              previous.current = e.target.value;
              return;
            }
            e.target.value = previous.current;
            setAdding(true);
          }}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
          <option value={ADD_NEW}>+ Add new {noun}…</option>
        </select>
      </label>

      {adding ? (
        <Modal
          open
          onClose={close}
          title={`New ${noun}`}
          description={`It'll be available everywhere ${plural} are, straight away.`}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
            <label className="flex flex-col gap-1 text-sm">
              Name
              {/* autoFocus is right here: the dialog exists for this one field,
                  and it was opened by a deliberate click. */}
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={kind === "brand" ? "Geek Bar" : kind === "category" ? "Disposable Vapes" : "$24.99 items"}
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={pending || !newName.trim()}
                className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
              >
                {pending ? "Creating..." : `Create ${noun}`}
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
