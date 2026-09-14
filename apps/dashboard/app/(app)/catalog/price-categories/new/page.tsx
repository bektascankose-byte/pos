import { createPriceCategoryAction } from "../../actions";

export default async function NewPriceCategoryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-xl font-semibold">New price category</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        Give it a name, then add members from the catalog list or by scanning them on its own page.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        action={createPriceCategoryAction}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            name="name"
            required
            placeholder="9.99 tier"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <button
          type="submit"
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Create category
        </button>
      </form>
    </div>
  );
}
