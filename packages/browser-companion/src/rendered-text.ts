import { hasHiddenStyles, HIDDEN_CLASS_NAMES } from '@inklabs/shared/security/untrusted-content';

/** Whole-page visibility, not viewport visibility: ordinary below-the-fold
 * flow stays readable. This is a conservative DOM filter, not a pixel oracle. */
export function renderedElement(element: Element): boolean {
  let depth = 0;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (++depth > 64) return false;
    if (
      node.hasAttribute('hidden') ||
      node.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true' ||
      [...node.classList].some((name) => HIDDEN_CLASS_NAMES.has(name.toLowerCase())) ||
      node.matches('dialog:not([open])')
    )
      return false;
    if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = node.querySelector(':scope > summary');
      if (!summary?.contains(element)) return false;
    }
    const style = getComputedStyle(node);
    if (style.visibility !== 'visible') return false;
    if (
      hasHiddenStyles((property) => {
        // Inherited text properties are tested at the text's own element: a
        // descendant can restore a visible font or fill under a hidden one.
        if (
          node !== element &&
          ['font-size', 'color', '-webkit-text-fill-color', 'text-indent'].includes(property)
        )
          return undefined;
        return style.getPropertyValue(property);
      })
    )
      return false;
  }
  return Array.from(element.getClientRects()).some(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.left < document.documentElement.clientWidth
  );
}

/** Range geometry catches zero-size glyphs and clipped text even when their
 * containing element has a nonzero box. No bottom-of-viewport test is used. */
export function renderedText(node: Node): boolean {
  const parent = node.parentElement;
  if (!parent || !renderedElement(parent)) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0
  );
  if (!rects.length || rects.length > 256) return false;
  return rects.every((rect) => {
    if (rect.right <= 0 || rect.left >= document.documentElement.clientWidth) return false;
    let depth = 0;
    for (let ancestor: Element | null = parent; ancestor; ancestor = ancestor.parentElement) {
      if (++depth > 64) return false;
      const style = getComputedStyle(ancestor);
      if (style.position === 'fixed' && (rect.bottom <= 0 || rect.top >= innerHeight)) return false;
      const box = ancestor.getBoundingClientRect();
      // A partially clipped run is omitted rather than exporting its hidden
      // suffix. This can omit some visible text; it never expands the range.
      if (
        ['hidden', 'clip'].includes(style.overflowX) &&
        (rect.left < box.left || rect.right > box.right)
      )
        return false;
      if (
        ['hidden', 'clip'].includes(style.overflowY) &&
        (rect.top < box.top || rect.bottom > box.bottom)
      )
        return false;
    }
    return true;
  });
}
