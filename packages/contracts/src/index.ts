/**
 * @snappos/contracts
 *
 * Zod schemas are the single source of truth for every boundary in the system.
 * TypeScript types are inferred from them, the OpenAPI document is generated
 * from them, and the Kotlin client for the register is generated from that.
 * One definition, three consumers, no hand written duplicate that drifts.
 */

export * from './money.js';
export * from './primitives.js';
export * from './identity.js';
export * from './catalog.js';
export * from './customers.js';
export * from './data-transfer.js';
export * from './employees.js';
export * from './inventory.js';
export * from './invoicing.js';
export * from './loyalty.js';
export * from './marketing.js';
export * from './onboarding.js';
export * from './purchasing.js';
export * from './reports.js';
export * from './sales.js';
export * from './scheduling.js';
export * from './sync.js';
export * from './errors.js';
