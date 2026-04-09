const CJK_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]/gu;
const LATIN_WORD_REGEX = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const URL_REGEX = /https?:\/\/\S+|www\.\S+/gi;
const HANDLE_REGEX = /(^|[\s([{（【])@[\w.]+/gu;
const HASHTAG_REGEX = /(^|[\s([{（【])#[\p{L}\p{N}_-]+/gu;
const NUMBER_REGEX = /\b\d+(?::\d+){0,2}(?:[.,]\d+)?%?\b/g;

const ENGLISH_FUNCTION_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'for',
  'from',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'their',
  'there',
  'they',
  'this',
  'to',
  'we',
  'with',
  'you',
]);

export interface MixedLanguageAnalysis {
  normalizedText: string;
  cjkCount: number;
  latinCharCount: number;
  latinWordCount: number;
  englishFunctionWordCount: number;
  effectiveLength: number;
  cjkRatio: number;
  maxLatinRun: number;
}

export function normalizeTextForLanguageAnalysis(text: string): string {
  return text
    .replace(URL_REGEX, ' ')
    .replace(HANDLE_REGEX, '$1 ')
    .replace(HASHTAG_REGEX, '$1 ')
    .replace(NUMBER_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMaxLatinRun(text: string): number {
  let maxRun = 0;
  let currentRun = 0;
  let lastIndex = 0;

  for (const match of text.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
    const separator = text.slice(lastIndex, match.index ?? 0);
    if (currentRun > 0 && !/^[\s,.;:!?/()\[\]{}"'“”‘’_+-]*$/.test(separator)) {
      currentRun = 0;
    }

    currentRun += 1;
    maxRun = Math.max(maxRun, currentRun);
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  return maxRun;
}

export function analyzeMixedLanguageText(text: string): MixedLanguageAnalysis {
  const normalizedText = normalizeTextForLanguageAnalysis(text);
  const cjkCount = (normalizedText.match(CJK_REGEX) ?? []).length;
  const latinWords = normalizedText.match(LATIN_WORD_REGEX) ?? [];
  const latinCharCount = latinWords.reduce((total, word) => total + word.length, 0);
  const englishFunctionWordCount = latinWords.reduce(
    (total, word) => total + (ENGLISH_FUNCTION_WORDS.has(word.toLowerCase()) ? 1 : 0),
    0,
  );
  const effectiveLength = cjkCount + latinCharCount;

  return {
    normalizedText,
    cjkCount,
    latinCharCount,
    latinWordCount: latinWords.length,
    englishFunctionWordCount,
    effectiveLength,
    cjkRatio: effectiveLength === 0 ? 0 : cjkCount / effectiveLength,
    maxLatinRun: getMaxLatinRun(normalizedText),
  };
}

export function shouldSkipXMixedChineseText(text: string): boolean {
  const analysis = analyzeMixedLanguageText(text);

  if (analysis.effectiveLength === 0 || analysis.cjkCount < 4) {
    return false;
  }

  if (analysis.latinWordCount === 0) {
    return true;
  }

  if (analysis.maxLatinRun >= 4 || analysis.latinWordCount >= 5) {
    return false;
  }

  if (analysis.englishFunctionWordCount > 0) {
    return analysis.cjkRatio >= 0.55 && analysis.latinWordCount <= 3;
  }

  if (analysis.latinWordCount <= 2 && analysis.cjkCount >= 5) {
    return true;
  }

  if (analysis.latinWordCount <= 3 && analysis.cjkRatio >= 0.4) {
    return true;
  }

  return false;
}
