/**
 * The `agent_identities.metadata.client` value that makes an identity an
 * inkling. A leaf module, so a pure seam (trigger-delivery.ts) can tell an
 * inkling apart without importing the inkling services. inkling-service.ts
 * re-exports it; this is the one definition.
 */
export const INKLING_CLIENT = 'inkling-mobile';
