import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 py-10">
      <h1 className="display text-5xl font-extrabold uppercase">Not here</h1>
      <p className="text-[var(--muted)]">
        That page doesn&apos;t exist, or the item isn&apos;t available online any more.
      </p>
      <Link href="/" className="btn btn-primary">
        Back to the shop
      </Link>
    </div>
  );
}
