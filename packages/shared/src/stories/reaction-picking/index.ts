/**
 * The reaction-picking story: browsing and searching every emoji in the full
 * picker. It carries the catalog's names and keywords, so a client loads it
 * only when the picker opens; the quick row never imports it. What a reaction
 * may be added with is the reacting story's rule.
 */

export * from './search.js';
export { SEARCH_ALIASES, type SearchAlias } from './search-aliases.js';
