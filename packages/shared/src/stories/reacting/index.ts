/**
 * The reacting story: which emoji a person may react with. The rule is one
 * exact lookup over a pinned, versioned catalog, shared by the server, the
 * dashboard and (as a byte-identical copy) the Inkling app. It is small on
 * purpose: names, keywords and search live in the reaction-picking story,
 * which a client loads only when the full picker opens.
 */

export * from './normalize.js';
