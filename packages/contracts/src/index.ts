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
export * from './inventory.js';
export * from './sync.js';
export * from './errors.js';
