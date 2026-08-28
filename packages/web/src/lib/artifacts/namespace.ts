/**
 * The Library derives its folders from artifact URIs: ink://<namespace>/<rest>.
 * Folders are never stored — the URI is the single source of truth, so there
 * is nothing to drift (spec:library). URIs that don't parse bucket into
 * 'unfiled' rather than disappearing.
 */
export function artifactNamespace(uri: string): string {
  const match = /^ink:\/\/([^/]+)\//.exec(uri);
  return match ? match[1] : 'unfiled';
}

export interface NamespaceShelf<T> {
  namespace: string;
  items: T[];
}

/**
 * Group artifacts into namespace shelves: largest shelf first, ties broken
 * alphabetically; the incoming item order (API sorts by last updated) is
 * preserved within each shelf.
 */
export function groupByNamespace<T extends { uri: string }>(items: T[]): NamespaceShelf<T>[] {
  const shelves = new Map<string, T[]>();
  for (const item of items) {
    const ns = artifactNamespace(item.uri);
    const bucket = shelves.get(ns);
    if (bucket) {
      bucket.push(item);
    } else {
      shelves.set(ns, [item]);
    }
  }
  return Array.from(shelves.entries())
    .map(([namespace, grouped]) => ({ namespace, items: grouped }))
    .sort((a, b) => b.items.length - a.items.length || a.namespace.localeCompare(b.namespace));
}
