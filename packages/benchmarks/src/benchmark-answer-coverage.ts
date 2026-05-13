const ANSWER_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'they',
  'to',
  'was',
  'were',
  'with',
  'you',
]);

export function normalizeAnswerText(text: string | number): string {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTokens(text: string | number): string[] {
  const normalized = normalizeAnswerText(text);
  return normalized ? normalized.split(' ') : [];
}

function containsNormalizedPhrase(text: string, answer: string | number): boolean {
  const normalizedText = normalizeAnswerText(text);
  const normalizedAnswer = normalizeAnswerText(answer);
  if (!normalizedText || !normalizedAnswer) return false;
  return ` ${normalizedText} `.includes(` ${normalizedAnswer} `);
}

export function answerTokenCoverage(text: string, answer: string | number): number {
  if (containsNormalizedPhrase(text, answer)) return 1;

  const textTokens = new Set(normalizedTokens(text));
  const answerTokens = normalizedTokens(answer)
    .filter((token) => token.length >= 3 || /^\d+$/.test(token))
    .filter((token) => !ANSWER_STOPWORDS.has(token));

  if (answerTokens.length === 0) return 0;
  const hitCount = answerTokens.filter((token) => textTokens.has(token)).length;
  return hitCount / answerTokens.length;
}

export function hasAnswer(text: string, answer: string | number): boolean {
  const coverage = answerTokenCoverage(text, answer);
  if (coverage >= 0.8) return true;

  const normalizedAnswer = normalizeAnswerText(answer);
  return normalizedAnswer.length >= 4 && containsNormalizedPhrase(text, answer);
}

export function hasOptionalAnswer(
  text: string,
  answer: string | number | null | undefined
): boolean | null {
  if (answer === null || answer === undefined) return null;
  const normalizedAnswer = normalizeAnswerText(answer);
  if (!normalizedAnswer) return null;
  return hasAnswer(text, answer);
}

export function compact(text: string, maxChars = 500): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function snippetAroundAnswer(text: string, answer: string | number, maxChars = 700): string {
  const normalizedAnswer = normalizeAnswerText(answer);
  const normalizedText = normalizeAnswerText(text);
  const index = normalizedAnswer ? normalizedText.indexOf(normalizedAnswer) : -1;
  if (index < 0) return compact(text, maxChars);

  // Indexes after normalization are approximate; use a proportional source slice.
  const ratio = index / Math.max(normalizedText.length, 1);
  const sourceIndex = Math.floor(text.length * ratio);
  const start = Math.max(0, sourceIndex - Math.floor(maxChars / 2));
  return compact(text.slice(start, start + maxChars), maxChars);
}
