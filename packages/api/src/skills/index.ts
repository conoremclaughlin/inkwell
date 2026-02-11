/**
 * Skills Module
 *
 * Unified skill system supporting multiple skill types:
 * - mini-app: Code-based skills with functions
 * - cli: External CLI tool wrappers
 * - guide: Markdown guides for specific situations
 *
 * Skills can be loaded from:
 * - Local filesystem (~/.pcp/skills/, builtin)
 * - Cloud registry (Supabase database)
 */

export * from './types';
export * from './eligibility';
export * from './loader';
export * from './service';
export * from './repository';
export * from './cloud-service';
export * from './providers';
