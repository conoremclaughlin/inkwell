import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderedText } from './rendered-text';

let rects: DOMRect[];
beforeEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '<div><span>Visible text</span></div>';
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(10, 10, 100, 20),
  ] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
  rects = [new DOMRect(10, 10, 100, 20)];
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => rects,
  });
});
const text = () => document.querySelector('span')!.firstChild!;
describe('whole-page text geometry (mock layout; Chromium evidence is separate)', () => {
  it('keeps ordinary text below the fold and above a scrolled viewport', () => {
    rects = [new DOMRect(10, 2000, 100, 20)];
    expect(renderedText(text())).toBe(true);
    rects = [new DOMRect(10, -2000, 100, 20)];
    expect(renderedText(text())).toBe(true);
  });
  it('rejects a mixed run with one line clipped by its ancestor', () => {
    document.querySelector('div')!.style.overflowY = 'hidden';
    rects.push(new DOMRect(10, 600, 100, 20));
    expect(renderedText(text())).toBe(false);
  });
  it('rejects zero-area glyphs and horizontally off-canvas text', () => {
    rects = [new DOMRect(10, 10, 0, 0)];
    expect(renderedText(text())).toBe(false);
    rects = [new DOMRect(-1000, 10, 100, 20)];
    expect(renderedText(text())).toBe(false);
  });
  it('bounds ancestry and does not mistake nonzero parent boxes for visible text', () => {
    document.body.innerHTML = '<div>'.repeat(80) + '<span>Text</span>' + '</div>'.repeat(80);
    expect(renderedText(text())).toBe(false);
  });
});
