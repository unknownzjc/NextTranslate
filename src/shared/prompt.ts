export const NT_SEPARATOR = '∥NT∥';

interface TranslateRequestParams {
  texts: string[];
  targetLanguage: string;
  model: string;
  mode: 'json' | 'separator';
  glossary?: string[];
  purpose?: 'selection';
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature: number;
  response_format?: { type: 'json_object' };
}

const GLOSSARY_BLOCK = (glossary: string[]) =>
  `\nGlossary — translate these terms consistently across all paragraphs:\n${glossary.join(', ')}`;

function buildSystemPrompt(targetLanguage: string, mode: 'json' | 'separator', glossary?: string[], purpose?: 'selection'): string {
  const glossaryStr = glossary && glossary.length > 0 ? GLOSSARY_BLOCK(glossary) : '';

  if (mode === 'json') {
    if (purpose === 'selection') {
      return `You are a dictionary assistant. For the given word or phrase:
1. Provide the meaning or translation in ${targetLanguage}. Include part of speech, common definitions, and any relevant nuances.
2. Provide 2-3 example sentences in the original language, each followed by its ${targetLanguage} translation on the next line.

Rules:
- You will receive a JSON object with a "texts" array containing the word(s) to define.
- Return a JSON object with a "translations" array containing the dictionary-style output.
- The "translations" array MUST have the same length as the "texts" array.
- Format each translation as plain text. Use blank lines between the definition section and examples section.
- Keep technical terms in their original form when appropriate.${glossaryStr}`;
    }
    return `You are a translation engine. Translate the following text into ${targetLanguage}.
Rules:
- You will receive a JSON object with a "texts" array containing paragraphs to translate.
- Return a JSON object with a "translations" array containing the translated paragraphs.
- The "translations" array MUST have the same length as the "texts" array.
- Output plain text only in each translation. Do not use any markdown formatting.
- Keep proper nouns, brand names, and technical terms in their original form when appropriate.
- Preserve placeholders like ⟨NT_CODE_N⟩ exactly as-is. Do not translate, modify, or remove them.
- Auto-detect the source language. If a paragraph is already in ${targetLanguage}, return it as-is.${glossaryStr}`;
  }

  return `You are a translation engine. Translate the following text into ${targetLanguage}.
Rules:
- Preserve the original paragraph structure.
- Output plain text only. Do not use any markdown formatting (no **, no ##, no \`, no - lists).
- Paragraphs are separated by "${NT_SEPARATOR}". You MUST return the same number of "${NT_SEPARATOR}" separated sections.
- Only output the translated text. Do not add explanations, notes, or extra content.
- Keep proper nouns, brand names, and technical terms in their original form when appropriate.
- Preserve placeholders like ⟨NT_CODE_N⟩ exactly as-is. Do not translate, modify, or remove them.
- Auto-detect the source language. If a paragraph is already in ${targetLanguage}, return it as-is.${glossaryStr}`;
}

export function buildTranslateRequest(params: TranslateRequestParams): ChatCompletionRequest {
  const { texts, targetLanguage, model, mode, glossary, purpose } = params;
  const systemPrompt = buildSystemPrompt(targetLanguage, mode, glossary, purpose);

  const userContent = mode === 'json'
    ? JSON.stringify({ texts })
    : texts.join(`\n${NT_SEPARATOR}\n`);

  const request: ChatCompletionRequest = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
  };

  if (mode === 'json') {
    request.response_format = { type: 'json_object' };
  }

  return request;
}

// --- Response parsing ---

interface ParsedTranslation {
  translations: string[];
}

export function parseJsonModeResponse(raw: string, expectedCount: number): ParsedTranslation | null {
  let text = raw.trim();

  let parsed = tryParseJson(text);

  // Strip markdown code block
  if (!parsed) {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      parsed = tryParseJson(codeBlockMatch[1].trim());
    }
  }

  if (parsed && Array.isArray(parsed.translations)) {
    if (parsed.translations.length === expectedCount) {
      return { translations: parsed.translations.map((t: unknown) => String(t).trim()) };
    }
    return null;
  }

  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseSeparatorModeResponse(raw: string, expectedCount: number): ParsedTranslation | null {
  const text = raw.trim();

  // Strict mode: split by \n∥NT∥\n
  let parts = text.split(`\n${NT_SEPARATOR}\n`).map(s => s.trim());
  if (parts.length === expectedCount) {
    return { translations: parts };
  }

  // Lenient mode: split by ∥NT∥
  parts = text.split(NT_SEPARATOR).map(s => s.trim());
  if (parts.length === expectedCount) {
    return { translations: parts };
  }

  return null;
}
