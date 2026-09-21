import {
  MAX_FIELDS,
  MAX_TEXT,
  assertFresh,
  pageUrl,
  parseProposal,
  type BrowserSnapshot,
} from './protocol';

const OMIT =
  'script,style,noscript,template,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]';
const SENSITIVE =
  /passw|passwd|secret|token|api.?key|credential|credit.?card|card.?number|cvv|cvc|security.?code|one.?time|otp|social.?security|\bssn\b|routing.?number|bank.?account/i;
const PRIVATE_AUTOCOMPLETE =
  /(?:^|\s)(?:current-password|new-password|one-time-code|cc-\S+)(?:\s|$)/i;
type Field = HTMLInputElement | HTMLTextAreaElement;

function visible(element: Element): boolean {
  if (element.closest('[hidden],[aria-hidden="true"],dialog:not([open])')) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0')
      return false;
  }
  return element.getClientRects().length > 0;
}
function label(field: Field): string {
  // A wrapping label can contain textarea text or hidden descendants. Never
  // serialize its raw textContent as a shortcut around capture exclusions.
  const enclosing = field.labels?.[0];
  let labelText = '';
  if (enclosing) {
    const walker = document.createTreeWalker(enclosing, NodeFilter.SHOW_TEXT);
    let visited = 0;
    while (walker.nextNode() && labelText.length < 160 && ++visited <= 1000) {
      const parent = walker.currentNode.parentElement;
      if (parent && !parent.closest(OMIT) && visible(parent))
        labelText += walker.currentNode.textContent || '';
    }
  }
  return (
    labelText ||
    field.getAttribute('aria-label') ||
    field.getAttribute('placeholder') ||
    field.name ||
    'Text field'
  )
    .trim()
    .slice(0, 160);
}
function eligible(field: Field): boolean {
  return (
    !field.disabled &&
    !field.readOnly &&
    visible(field) &&
    (field instanceof HTMLTextAreaElement || field.type === 'text') &&
    !PRIVATE_AUTOCOMPLETE.test(field.autocomplete) &&
    !SENSITIVE.test(
      [field.name, field.id, label(field), field.getAttribute('autocomplete')].join(' ')
    )
  );
}
function fingerprint(field: Field): string {
  return JSON.stringify([
    field.tagName,
    field.type,
    field.id,
    field.name,
    label(field),
    field.autocomplete,
    field.form?.action,
    field.form?.method,
    field.maxLength,
  ]);
}

/** Lives in an extension ISOLATED world, never a page-visible DOM attribute. */
export class PageSession {
  private current?: {
    snapshot: BrowserSnapshot;
    href: string;
    fields: Map<string, { element: Field; value: string; fingerprint: string }>;
    consumed: boolean;
  };

  capture(mode: 'selection' | 'page'): BrowserSnapshot {
    this.current = undefined;
    const url = pageUrl(location.href);
    const selection = window.getSelection();
    if (mode === 'selection' && (!selection || selection.isCollapsed))
      throw new Error('Select page text first, or choose visible page text.');
    const fields = new Map<string, { element: Field; value: string; fingerprint: string }>();
    const snapshot: BrowserSnapshot = {
      version: 1,
      id: crypto.randomUUID(),
      capturedAt: Date.now(),
      url,
      title: document.title.slice(0, 200),
      mode,
      text: '',
      truncated: false,
      fields: [],
    };
    // Text-node traversal excludes all form/editable values before extraction.
    // Bounded work on enormous pages; truncation is explicit, not silent.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let visited = 0;
    while (walker.nextNode()) {
      if (++visited > 20_000 || snapshot.text.length >= MAX_TEXT) {
        snapshot.truncated = true;
        break;
      }
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(OMIT) || !visible(parent)) continue;
      let part = node.textContent || '';
      if (mode === 'selection') {
        const chunks: string[] = [];
        for (let i = 0; i < selection!.rangeCount; i++) {
          const range = selection!.getRangeAt(i);
          if (!range.intersectsNode(node)) continue;
          chunks.push(
            part.slice(
              range.startContainer === node ? range.startOffset : 0,
              range.endContainer === node ? range.endOffset : part.length
            )
          );
        }
        part = chunks.join(' ');
      }
      part = part.trim();
      if (part) snapshot.text += `${part}\n`;
    }
    if (snapshot.text.length > MAX_TEXT) {
      snapshot.truncated = true;
      snapshot.text = snapshot.text.slice(0, MAX_TEXT);
    }
    let visitedFields = 0;
    for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input,textarea'
    )) {
      if (fields.size >= MAX_FIELDS || ++visitedFields > 4000) {
        snapshot.truncated = true;
        break;
      }
      if (!eligible(element)) continue;
      const id = `f${fields.size}`;
      fields.set(id, { element, value: element.value, fingerprint: fingerprint(element) });
      snapshot.fields.push({
        id,
        label: label(element),
        kind: element instanceof HTMLTextAreaElement ? 'textarea' : 'text',
      });
    }
    this.current = { snapshot, href: location.href, fields, consumed: false };
    return snapshot;
  }

  apply(input: unknown): { applied: number } {
    const state = this.current;
    if (!state || state.consumed)
      throw new Error('Capture a fresh snapshot before applying another proposal.');
    assertFresh(state.snapshot);
    if (location.href !== state.href) throw new Error('The page navigated. Capture it again.');
    const proposal = parseProposal(input, state.snapshot);
    const targets = proposal.changes.map((change) => {
      const target = state.fields.get(change.fieldId)!;
      const validate = () => {
        if (
          location.href !== state.href ||
          !target.element.isConnected ||
          !eligible(target.element) ||
          fingerprint(target.element) !== target.fingerprint ||
          target.element.value !== target.value ||
          (target.element.maxLength >= 0 && change.value.length > target.element.maxLength)
        ) {
          throw new Error(
            'A field changed since capture. Some earlier changes may have applied; inspect the page and recapture.'
          );
        }
      };
      validate();
      return { target, change, validate };
    });
    // At-most-once local application. A page listener can autosave or mutate
    // later fields; there is intentionally no promise of transactional undo.
    state.consumed = true;
    for (const { target, change, validate } of targets) {
      validate();
      const prototype =
        target.element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target.element, change.value);
      target.element.dispatchEvent(new Event('input', { bubbles: true }));
      target.element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { applied: targets.length };
  }
}
