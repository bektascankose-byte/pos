"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { cancelOrderAction, type CancelState } from "@/app/track/[token]/actions";

function CancelButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-quiet text-sm" disabled={pending}>
      {pending ? "Cancelling…" : "Cancel this order"}
    </button>
  );
}

export function CancelOrder({ token }: { token: string }) {
  const [state, action] = useActionState<CancelState, FormData>(cancelOrderAction.bind(null, token), { error: null });
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm("Cancel this order? The shop will stop preparing it.")) event.preventDefault();
      }}
      className="flex flex-col items-start gap-2"
    >
      <CancelButton />
      {state.error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
