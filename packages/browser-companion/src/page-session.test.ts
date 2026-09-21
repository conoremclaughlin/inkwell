// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageSession } from './page-session';

beforeEach(() => {
  vi.restoreAllMocks();
  // jsdom has no layout. Only this unit fixture supplies a visible rectangle.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  document.body.innerHTML =
    '<p>Visible synthetic text</p><label for="topic">Topic</label><input id="topic" value="not shared"><label for="details">Details</label><textarea id="details">private draft not shared</textarea><button type="submit">Submit</button>';
});
describe('isolated page capture and confirm-only fill', () => {
  it('does not leak wrapping-label textarea or hidden contents via field labels', () => {
    document.body.innerHTML =
      '<label>Details<textarea>private synthetic draft</textarea><span hidden>private hidden text</span></label>';
    const capture = new PageSession().capture('page');
    expect(capture.fields[0]?.label).toBe('Details');
    expect(JSON.stringify(capture)).not.toContain('private');
  });
  it('never serializes current input or textarea values', () => {
    const capture = new PageSession().capture('page');
    expect(capture.fields).toHaveLength(2);
    expect(JSON.stringify(capture)).not.toContain('not shared');
    expect(capture.text).toContain('Visible synthetic text');
  });
  it('excludes sensitive, hidden, disabled, readonly and unsupported fields before reading values', () => {
    document.body.innerHTML +=
      '<input type="password"><input type="hidden"><input autocomplete="one-time-code"><input autocomplete="cc-number"><input name="api_key"><input aria-label="Bank account"><input disabled><input readonly><input type="file"><input type="email"><div style="display:none"><input value="hidden"><p>hidden text</p></div><div contenteditable>private editable text</div>';
    const capture = new PageSession().capture('page');
    expect(capture.fields).toHaveLength(2);
    expect(capture.text).not.toContain('hidden text');
    expect(capture.text).not.toContain('private editable text');
  });
  it('selection capture includes only selected text, not entire adjacent nodes', () => {
    const node = document.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 8);
    range.setEnd(node, 17);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(new PageSession().capture('selection').text).toBe('synthetic\n');
    selection.removeAllRanges();
    expect(() => new PageSession().capture('selection')).toThrow('Select');
  });
  it('applies once, emits input/change but never invokes submit or clicks', () => {
    const session = new PageSession();
    const snapshot = session.capture('page');
    const input = document.querySelector('input')!;
    const events: string[] = [];
    for (const type of ['input', 'change']) input.addEventListener(type, () => events.push(type));
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
    const proposal = {
      version: 1,
      snapshotId: snapshot.id,
      changes: [{ fieldId: 'f0', value: '<script>literal text</script>' }],
    };
    expect(session.apply(proposal)).toEqual({ applied: 1 });
    expect(input.value).toBe('<script>literal text</script>');
    expect(events).toEqual(['input', 'change']);
    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(() => session.apply(proposal)).toThrow('fresh snapshot');
  });
  it.each(['replace', 'edit', 'hide', 'password', 'label', 'readonly', 'maxlength'])(
    'rejects %s drift without writing any field',
    (kind) => {
      const session = new PageSession();
      const snapshot = session.capture('page');
      const input = document.querySelector('input')!;
      if (kind === 'replace') input.replaceWith(input.cloneNode(true));
      if (kind === 'edit') input.value = 'human edit';
      if (kind === 'hide') input.hidden = true;
      if (kind === 'password') input.type = 'password';
      if (kind === 'label') document.querySelector('label')!.textContent = 'New meaning';
      if (kind === 'readonly') input.readOnly = true;
      if (kind === 'maxlength') input.maxLength = 1;
      expect(() =>
        session.apply({
          version: 1,
          snapshotId: snapshot.id,
          changes: [
            { fieldId: 'f1', value: 'later' },
            { fieldId: 'f0', value: 'new' },
          ],
        })
      ).toThrow('changed');
      expect(document.querySelector('textarea')!.value).toBe('private draft not shared');
    }
  );
  it('stops with an honest partial result if site listeners change subsequent fields', () => {
    const session = new PageSession();
    const snapshot = session.capture('page');
    document.querySelector('input')!.addEventListener('input', () => {
      document.querySelector('textarea')!.value = 'site autosave changed this';
    });
    expect(() =>
      session.apply({
        version: 1,
        snapshotId: snapshot.id,
        changes: [
          { fieldId: 'f0', value: 'approved' },
          { fieldId: 'f1', value: 'overwrite' },
        ],
      })
    ).toThrow('earlier changes may have applied');
    expect(document.querySelector('textarea')!.value).toBe('site autosave changed this');
  });
});
