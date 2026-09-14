/**
 * Returned by a Server Action that a client component calls directly
 * (instead of binding to `<form action={...}>`) so it can update its own
 * local state or show an inline error, rather than the action ending the
 * interaction with `redirect()` -- which is what used to force a full page
 * navigation for every click across this app.
 */
export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
