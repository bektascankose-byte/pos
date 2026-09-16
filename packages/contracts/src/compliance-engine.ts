/**
 * The compliance engine.
 *
 * Rules are rows, not code. `docs/ARCHITECTURE.md` section I is blunt about
 * why: this shop's categories moved three times in twelve months and a federal
 * hemp redefinition lands in November 2026, so "a compliance engine that hard
 * codes today's rules is obsolete before it ships". The owner must be able to
 * switch a whole category off at 11pm on a Tuesday without a deploy.
 *
 * The shape here is `compliance_rules` from migration 0002 exactly — that
 * table has existed since the foundation, unused, and is better designed than
 * the one this evaluator was first written against. Notably it matches
 * categories by **path prefix**, so a rule on `vapes.` governs the whole
 * subtree without naming every category under it, and it carries `overridable`
 * and `deny_message`, which is what lets a cashier be told what to do about a
 * refusal rather than only that there was one.
 *
 * This file is the evaluator only — pure, synchronous, no database, no clock
 * of its own. `asOf` is always passed in, because "what were we allowed to
 * sell last March" is a question an auditor asks and a function that reads
 * `Date.now()` cannot answer.
 *
 * It is deliberately the same shape as the pricing engine: a pure function
 * plus a JSON fixture suite that is the arbiter, so the Kotlin implementation
 * on the register can be proved to agree rather than assumed to.
 *
 * **Nothing here is legal advice, and the engine knowing a rule does not make
 * the rule correct.** Every row carries `authority_note`, `source_url` and
 * `reviewed_by` precisely so a qualified person can check it.
 */

/** How the goods reach the customer. Each is a separate legal question. */
export type ComplianceChannel = 'in_store' | 'pickup' | 'delivery' | 'online_listing' | 'ship';

export type ComplianceEffect =
  | 'allow'
  | 'deny'
  | 'require_age'
  | 'require_id_scan'
  | 'require_manager'
  | 'require_provider_verification';

/**
 * One row of `compliance_rules`.
 *
 * Every `scope*` and `subject*` field is null-means-any. A rule with none set
 * applies to everything, everywhere, through every channel — which is what a
 * platform baseline looks like.
 */
export interface ComplianceRule {
  id: string;
  /** Null is a platform default shipped with the software. An org's own rule of equal specificity beats it. */
  orgId: string | null;
  name: string;
  priority: number;

  scopeCountry?: string | null;
  scopeRegion?: string | null;
  scopeCounty?: string | null;
  scopeCity?: string | null;
  scopeStoreId?: string | null;

  /** `vapes.` matches the whole subtree. The materialized path is what makes this cheap. */
  subjectCategoryPathPrefix?: string | null;
  subjectRegulatedClass?: string | null;
  subjectProductId?: string | null;
  subjectVariantId?: string | null;
  /** Attribute predicate: every key here must be equal on the item. */
  subjectMatch?: Record<string, string> | null;

  /** Null means every channel. */
  channel?: ComplianceChannel | null;
  effect: ComplianceEffect;
  /** Only with `effect = 'require_age'`. */
  effectAge?: number | null;
  /** Whether a manager may override a denial. Never true by default. */
  overridable?: boolean;
  /** Shown to the cashier verbatim. */
  denyMessage?: string | null;

  effectiveFrom: string;
  effectiveTo?: string | null;
  authorityNote?: string | null;
}

/** The thing being judged. */
export interface ComplianceSubject {
  variantId: string;
  productId?: string | null;
  /** The category's materialized path, e.g. `vapes.disposable.geek-bar`. */
  categoryPath?: string | null;
  regulatedClass?: string | null;
  attributes?: Record<string, string> | null;
}

export interface ComplianceContext {
  channel: ComplianceChannel;
  /** Where the transaction happens: the store for in_store and pickup, the destination for delivery. */
  country?: string | null;
  region?: string | null;
  county?: string | null;
  city?: string | null;
  storeId?: string | null;
  /** ISO 8601. Never defaulted — see the file header. */
  asOf: string;
}

export interface ComplianceDecision {
  allowed: boolean;
  /** Plain language, shown to a cashier or a customer. Never a rule id on its own. */
  reason: string;
  minimumAge: number | null;
  requiresIdScan: boolean;
  requiresManager: boolean;
  requiresProviderVerification: boolean;
  /** True only when the denying rule says a manager may override it. */
  overridable: boolean;
  /** Every rule that applied, most specific first. The audit trail for this decision. */
  matchedRuleIds: string[];
}

/**
 * Decide whether one item may be sold, through one channel, at one moment.
 *
 * Ordering, in full: scope specificity, then subject specificity, then an
 * organization's own rule over a platform default, then priority, then `deny`
 * ahead of `allow`, then rule id. That last tiebreak is not decoration —
 * without a total order, two rules of equal weight could be applied in
 * whichever sequence the database happened to return them, and the TypeScript
 * and Kotlin engines would disagree on some carts and not others. That is the
 * bug this ordering exists to make impossible.
 *
 * **Fails closed.** If nothing matches, the answer is no.
 */
export function evaluateCompliance(
  rules: readonly ComplianceRule[],
  subject: ComplianceSubject,
  context: ComplianceContext,
): ComplianceDecision {
  const applicable = rules.filter((rule) => appliesTo(rule, subject, context)).sort(compareRules);

  const base: ComplianceDecision = {
    allowed: false,
    reason: '',
    minimumAge: null,
    requiresIdScan: false,
    requiresManager: false,
    requiresProviderVerification: false,
    overridable: false,
    matchedRuleIds: applicable.map((rule) => rule.id),
  };

  if (applicable.length === 0) {
    return {
      ...base,
      reason: `No rule covers selling this through ${readable(context.channel)}. Nothing is sold until a rule says it may be.`,
    };
  }

  // Requirements accumulate across every matching rule -- an item can need an
  // age, an ID scan and a provider check at once, and the strictest age wins
  // rather than the last one read.
  for (const rule of applicable) {
    switch (rule.effect) {
      case 'require_age':
        if (rule.effectAge != null) {
          base.minimumAge = Math.max(base.minimumAge ?? 0, rule.effectAge);
        }
        break;
      case 'require_id_scan':
        base.requiresIdScan = true;
        break;
      case 'require_manager':
        base.requiresManager = true;
        break;
      case 'require_provider_verification':
        base.requiresProviderVerification = true;
        break;
      default:
        break;
    }
  }

  // A deny anywhere in the matched set ends it, whatever its position: a rule
  // saying "not through this channel" is not outranked by a more specific rule
  // that merely says how old the buyer must be.
  const denial = applicable.find((rule) => rule.effect === 'deny');
  if (denial) {
    return {
      ...base,
      allowed: false,
      overridable: denial.overridable === true,
      reason:
        denial.denyMessage?.trim() ||
        denial.authorityNote?.trim() ||
        `Not available for ${readable(context.channel)}.`,
    };
  }

  // A rule saying "check ID" describes how to sell something, not that you
  // may. Reading it as permission is the mistake that sells a prohibited item
  // very carefully.
  if (!applicable.some((rule) => rule.effect === 'allow')) {
    return {
      ...base,
      allowed: false,
      reason: `No rule permits selling this through ${readable(context.channel)}.`,
    };
  }

  return { ...base, allowed: true, reason: describeRequirements(base) };
}

function appliesTo(
  rule: ComplianceRule,
  subject: ComplianceSubject,
  context: ComplianceContext,
): boolean {
  // Null channel means every channel.
  if (rule.channel != null && rule.channel !== context.channel) return false;
  if (!withinDates(rule, context.asOf)) return false;

  // Scope: every field the rule names must match. A named jurisdiction the
  // caller could not supply is a miss, not a pass -- guessing that an unknown
  // county is the rule's county is how a delivery reaches the wrong one.
  if (!scopeFieldMatches(rule.scopeCountry, context.country)) return false;
  if (!scopeFieldMatches(rule.scopeRegion, context.region)) return false;
  if (!scopeFieldMatches(rule.scopeCounty, context.county)) return false;
  if (!scopeFieldMatches(rule.scopeCity, context.city)) return false;
  if (!scopeFieldMatches(rule.scopeStoreId, context.storeId)) return false;

  if (rule.subjectVariantId && rule.subjectVariantId !== subject.variantId) return false;
  if (rule.subjectProductId && rule.subjectProductId !== subject.productId) return false;

  if (rule.subjectRegulatedClass) {
    if (normalize(rule.subjectRegulatedClass) !== normalize(subject.regulatedClass ?? '')) {
      return false;
    }
  }

  // Path prefix, so a rule on `vapes.` governs `vapes.disposable.geek-bar`
  // without anybody maintaining a list of category ids.
  if (rule.subjectCategoryPathPrefix) {
    const path = subject.categoryPath ?? '';
    if (!normalize(path).startsWith(normalize(rule.subjectCategoryPathPrefix))) return false;
  }

  if (rule.subjectMatch && Object.keys(rule.subjectMatch).length > 0) {
    const attributes = subject.attributes ?? {};
    for (const [key, value] of Object.entries(rule.subjectMatch)) {
      if (attributes[key] !== value) return false;
    }
  }

  return true;
}

/** Null on the rule means "any"; a value means the context must supply a matching one. */
function scopeFieldMatches(ruleValue: string | null | undefined, contextValue: string | null | undefined): boolean {
  if (ruleValue == null || ruleValue === '') return true;
  if (contextValue == null || contextValue === '') return false;
  return normalize(ruleValue) === normalize(contextValue);
}

/**
 * Half-open on purpose: `[effectiveFrom, effectiveTo)`.
 *
 * A rule that ends the instant its replacement begins must not both apply for
 * one shared millisecond, or a category is briefly governed by two
 * contradictory rules at the exact moment the law changed.
 */
function withinDates(rule: ComplianceRule, asOf: string): boolean {
  const at = Date.parse(asOf);
  if (Number.isNaN(at)) return false;

  const from = Date.parse(rule.effectiveFrom);
  if (Number.isNaN(from) || at < from) return false;

  if (rule.effectiveTo == null) return true;
  const to = Date.parse(rule.effectiveTo);
  return Number.isNaN(to) ? false : at < to;
}

/** Case and surrounding space vary by whoever typed the address; 'TX' and 'tx ' are one region. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** How narrowly a rule is scoped. Store beats city beats county beats region beats country. */
function scopeRank(rule: ComplianceRule): number {
  if (rule.scopeStoreId) return 4;
  if (rule.scopeCity) return 3;
  if (rule.scopeCounty) return 2;
  if (rule.scopeRegion) return 1;
  if (rule.scopeCountry) return 0;
  return -1; // scoped nowhere: the platform baseline
}

/** How specific a rule's subject is. A rule naming one variant outranks one naming a whole subtree. */
function subjectRank(rule: ComplianceRule): number {
  if (rule.subjectVariantId) return 4;
  if (rule.subjectProductId) return 3;
  if (rule.subjectRegulatedClass) return 2;
  if (rule.subjectCategoryPathPrefix) return 1;
  return rule.subjectMatch && Object.keys(rule.subjectMatch).length > 0 ? 1 : 0;
}

function compareRules(a: ComplianceRule, b: ComplianceRule): number {
  const scope = scopeRank(b) - scopeRank(a);
  if (scope !== 0) return scope;

  const subject = subjectRank(b) - subjectRank(a);
  if (subject !== 0) return subject;

  // An organization's own rule beats a platform default of equal specificity.
  const ownership = (a.orgId ? 0 : 1) - (b.orgId ? 0 : 1);
  if (ownership !== 0) return ownership;

  const priority = b.priority - a.priority;
  if (priority !== 0) return priority;

  const deny = (b.effect === 'deny' ? 1 : 0) - (a.effect === 'deny' ? 1 : 0);
  if (deny !== 0) return deny;

  // Total order. Without this the two engines can disagree; see evaluateCompliance.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function readable(channel: ComplianceChannel): string {
  switch (channel) {
    case 'in_store': return 'in-store sale';
    case 'pickup': return 'in-store pickup';
    case 'delivery': return 'local delivery';
    case 'online_listing': return 'the online store';
    case 'ship': return 'shipping';
  }
}

function describeRequirements(decision: ComplianceDecision): string {
  const parts: string[] = [];
  if (decision.minimumAge != null) parts.push(`buyer must be ${decision.minimumAge} or over`);
  if (decision.requiresIdScan) parts.push('ID must be scanned');
  if (decision.requiresProviderVerification) parts.push('identity must be verified online');
  if (decision.requiresManager) parts.push('a manager must approve');
  return parts.length === 0 ? 'Allowed.' : `Allowed: ${parts.join('; ')}.`;
}
