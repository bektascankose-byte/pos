"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Category, ComplianceRuleView } from "@snappos/contracts";
import { createRuleAction, endRuleAction } from "./actions";

const EFFECT_LABELS: Record<ComplianceRuleView["effect"], string> = {
  allow: "Allow",
  deny: "Don't allow",
  require_age: "Require age",
  require_id_scan: "Require ID scan",
  require_manager: "Require a manager",
  require_provider_verification: "Require online ID verification",
};

const CHANNEL_LABELS: Record<string, string> = {
  in_store: "At the counter",
  pickup: "Website pickup",
  delivery: "Delivery",
  online_listing: "Website listing",
  ship: "Shipping",
};

export function SellingRules({ rules, categories }: { rules: ComplianceRuleView[]; categories: Category[] }) {
  const own = rules.filter((rule) => !rule.platform);
  const builtIn = rules.filter((rule) => rule.platform);
  const allowsPickup = own.some((rule) => rule.live && rule.effect === "allow" && rule.channel === "pickup");

  return (
    <div className="flex flex-col gap-4">
      {!allowsPickup ? (
        <p
          role="status"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        >
          The website can&apos;t sell anything for pickup yet: none of your rules allow it.
        </p>
      ) : null}

      <AddRule categories={categories} />

      <RuleTable title="Your rules" rules={own} categories={categories} canEnd empty="You haven't added any rules." />
      <RuleTable title="Built in" rules={builtIn} categories={categories} canEnd={false} empty="None." />
    </div>
  );
}

function describeScope(rule: ComplianceRuleView, categories: Category[]): string {
  const parts: string[] = [];
  if (rule.subject_category_path_prefix) {
    const path = rule.subject_category_path_prefix.replace(/\.+$/, "");
    const category = categories.find((c) => c.path === path);
    parts.push(category ? `${category.name} and everything in it` : path);
  }
  if (rule.subject_regulated_class) parts.push(rule.subject_regulated_class.replace(/_/g, " "));
  if (parts.length === 0) parts.push("Everything");
  if (rule.scope_region) parts.push(`in ${rule.scope_region}`);
  return parts.join(", ");
}

function RuleTable({
  title,
  rules,
  categories,
  canEnd,
  empty,
}: {
  title: string;
  rules: ComplianceRuleView[];
  categories: Category[];
  canEnd: boolean;
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {rules.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2 font-normal">Rule</th>
                <th className="px-3 py-2 font-normal">Does</th>
                <th className="px-3 py-2 font-normal">For</th>
                <th className="px-3 py-2 font-normal">Where</th>
                <th className="px-3 py-2 font-normal">In force</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr
                  key={rule.id}
                  className={`border-t border-[var(--color-border)] align-top ${rule.live ? "" : "text-[var(--color-text-muted)]"}`}
                >
                  <td className="px-3 py-2">
                    <div>{rule.name}</div>
                    {rule.authority_note ? (
                      <div className="max-w-xs text-xs text-[var(--color-text-muted)]">{rule.authority_note}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {EFFECT_LABELS[rule.effect]}
                    {rule.effect === "require_age" && rule.effect_age ? ` ${rule.effect_age}+` : ""}
                  </td>
                  <td className="px-3 py-2">{describeScope(rule, categories)}</td>
                  <td className="px-3 py-2">{rule.channel ? CHANNEL_LABELS[rule.channel] : "Everywhere"}</td>
                  <td className="px-3 py-2">
                    {rule.live
                      ? `Since ${new Date(rule.effective_from).toLocaleDateString()}`
                      : rule.effective_to
                        ? `Ended ${new Date(rule.effective_to).toLocaleDateString()}`
                        : `From ${new Date(rule.effective_from).toLocaleDateString()}`}
                  </td>
                  <td className="px-3 py-2 text-right">{canEnd && rule.live ? <EndRule rule={rule} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EndRule({ rule }: { rule: ComplianceRuleView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
        onClick={() => {
          const reason = window.prompt(`End "${rule.name}" now?\n\nSay why. It stays on record as ended.`);
          if (!reason?.trim()) return;
          setError(null);
          startTransition(async () => {
            const result = await endRuleAction(rule.id, reason);
            if (result.ok) router.refresh();
            else setError(result.error);
          });
        }}
      >
        {pending ? "Ending…" : "End rule"}
      </button>
      {error ? <span className="text-xs text-[var(--color-error)]">{error}</span> : null}
    </span>
  );
}

function AddRule({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [effect, setEffect] = useState<"allow" | "deny" | "require_age">("allow");
  const [age, setAge] = useState("21");
  const [categoryPath, setCategoryPath] = useState("");
  const [denyMessage, setDenyMessage] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)]"
          onClick={() => setOpen(true)}
        >
          Add a rule
        </button>
      </div>
    );
  }

  const field = "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm";

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await createRuleAction({
            name: name.trim(),
            effect,
            channel: "pickup",
            ...(effect === "require_age" ? { effect_age: Number(age) } : {}),
            ...(categoryPath ? { category_path: categoryPath } : {}),
            ...(effect === "deny" && denyMessage.trim() ? { deny_message: denyMessage.trim() } : {}),
            authority_note: note.trim(),
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setOpen(false);
          setName("");
          setNote("");
          setDenyMessage("");
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm" htmlFor="rule-name">
          <span className="text-[var(--color-text-muted)]">Name</span>
          <input id="rule-name" required className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sell accessories online" />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="rule-effect">
          <span className="text-[var(--color-text-muted)]">For website pickup orders</span>
          <select
            id="rule-effect"
            className={field}
            value={effect}
            onChange={(e) => setEffect(e.target.value as typeof effect)}
          >
            <option value="allow">Allow</option>
            <option value="deny">Don&apos;t allow</option>
            <option value="require_age">Require a minimum age</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="rule-category">
          <span className="text-[var(--color-text-muted)]">Which items</span>
          <select id="rule-category" className={field} value={categoryPath} onChange={(e) => setCategoryPath(e.target.value)}>
            <option value="">Everything</option>
            {categories.map((category) => (
              <option key={category.id} value={category.path}>
                {"— ".repeat(category.depth)}
                {category.name}
              </option>
            ))}
          </select>
        </label>
        {effect === "require_age" ? (
          <label className="flex flex-col gap-1 text-sm" htmlFor="rule-age">
            <span className="text-[var(--color-text-muted)]">Minimum age</span>
            <input id="rule-age" inputMode="numeric" className={field} value={age} onChange={(e) => setAge(e.target.value)} />
          </label>
        ) : null}
        {effect === "deny" ? (
          <label className="flex flex-col gap-1 text-sm" htmlFor="rule-message">
            <span className="text-[var(--color-text-muted)]">What customers are told (optional)</span>
            <input id="rule-message" className={field} value={denyMessage} onChange={(e) => setDenyMessage(e.target.value)} placeholder="Available in store only" />
          </label>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-sm" htmlFor="rule-note">
        <span className="text-[var(--color-text-muted)]">Why this rule exists — the law, permit or decision behind it</span>
        <textarea
          id="rule-note"
          required
          minLength={10}
          rows={2}
          className={field}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reviewed with our attorney on …"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
        >
          {pending ? "Adding…" : "Add rule"}
        </button>
        <button type="button" className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        {error ? <span role="alert" className="text-sm text-[var(--color-error)]">{error}</span> : null}
      </div>
    </form>
  );
}
