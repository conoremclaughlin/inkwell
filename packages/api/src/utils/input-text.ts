/** Cheap shape check before signup; the identity provider validates the address. */
export function isPlausibleEmailAddress(value: string): boolean {
  if (!value || value.length > 254 || /\s/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0]) return false;
  const domain = parts[1];
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

/** Linear even for a long run of slashes, unlike an unanchored /\/+$/ scan. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}
