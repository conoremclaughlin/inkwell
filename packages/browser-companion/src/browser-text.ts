/** Narrow intake cleanup, not prompt-injection detection. Preserve writing,
 * joiners, variation selectors and the three Unicode subdivision-flag sequences.
 * Do not normalise scripts or log the removed text. */
export function cleanBrowserText(input: string): { text: string; removed: number } {
  let removed = 0;
  const text = input.replace(
    /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu,
    (match) => {
      if (match.startsWith('\u{1F3F4}')) return match;
      ++removed;
      return '';
    }
  );
  return { text, removed };
}
