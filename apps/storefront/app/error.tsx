"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 py-10">
      <h1 className="display text-5xl font-extrabold uppercase">Something went wrong</h1>
      <p className="text-[var(--muted)]">
        The page couldn&apos;t load. Your cart and any order you placed are safe. Try again in a moment.
      </p>
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
