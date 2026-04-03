import Defuddle from 'defuddle';

// --- Constants ---

const PARAGRAPH_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION', 'DT', 'DD']);
const SKIP_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT']);
const MIN_TEXT_LENGTH = 10;
const MAX_TEXT_LENGTH = 10000;
const DEFUDDLE_TIMEOUT_MS = 3000;

// --- Chinese detection ---

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

export function isChineseDominant(text: string): boolean {
  if (text.length === 0) return false;
  const stripped = text.replace(/\s/g, '');
  if (stripped.length === 0) return false;
  const cjkMatches = stripped.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  return cjkCount / stripped.length > 0.5;
}

// --- Element filtering ---

export function shouldSkipElement(el: Element): boolean {
  if (el.className && typeof el.className === 'string' && el.className.split(' ').some(c => c.startsWith('nt-'))) {
    return true;
  }
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (isHidden(el)) return true;

  const text = (el.textContent ?? '').replace(/\s/g, '');
  if (text.length < MIN_TEXT_LENGTH) return true;
  if (isChineseDominant(el.textContent ?? '')) return true;

  return false;
}

function isHidden(el: Element): boolean {
  if (el.tagName === 'TEMPLATE') return true;

  if (el instanceof HTMLElement) {
    if (el.offsetParent === null) {
      if (el.parentElement === document.body || el === document.body) return false;
      const position = getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') {
        const style = getComputedStyle(el);
        return style.display === 'none' || style.visibility === 'hidden';
      }
      return true;
    }
  }

  return false;
}

// --- Inline code protection ---

export function extractTextWithCodeProtection(el: Element): { text: string; codeMap: Map<string, string> } {
  const codeMap = new Map<string, string>();
  const codeElements = el.querySelectorAll(':scope > code, :scope code');

  if (codeElements.length === 0) {
    return { text: el.textContent ?? '', codeMap };
  }

  const clone = el.cloneNode(true) as Element;
  const cloneCodeElements = clone.querySelectorAll('code');

  cloneCodeElements.forEach((code, index) => {
    const placeholder = `⟨NT_CODE_${index}⟩`;
    const originalText = code.textContent ?? '';
    codeMap.set(placeholder, originalText);
    code.textContent = placeholder;
  });

  return { text: clone.textContent ?? '', codeMap };
}

export function restoreCodePlaceholders(translatedText: string, codeMap: Map<string, string>): string {
  if (codeMap.size === 0) return translatedText;

  let result = translatedText;
  for (const [placeholder, original] of codeMap) {
    result = result.replace(placeholder, original);
  }
  return result;
}

// --- Token estimation ---

export function estimateTokens(text: string): number {
  let cjkChars = 0;
  let otherChars = 0;

  for (const char of text) {
    if (CJK_REGEX.test(char)) {
      cjkChars++;
    } else {
      otherChars++;
    }
    CJK_REGEX.lastIndex = 0;
  }

  return cjkChars / 1.5 + otherChars / 3;
}

// --- Batch splitting ---

export function splitIntoBatches(texts: string[], tokenThreshold: number = 2000): number[][] {
  const batches: number[][] = [];
  let currentBatch: number[] = [];
  let currentTokens = 0;

  for (let i = 0; i < texts.length; i++) {
    const tokens = estimateTokens(texts[i]);

    if (tokens > tokenThreshold) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([i]);
      continue;
    }

    if (currentTokens + tokens > tokenThreshold && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(i);
    currentTokens += tokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// --- Glossary extraction ---

export function extractGlossaryTerms(texts: string[], maxTerms: number = 30): string[] {
  const termCounts = new Map<string, number>();

  for (const text of texts) {
    const matches = text.match(/\b[A-Z][a-zA-Z]*(?:\s+[A-Za-z]+){0,2}\b/g) ?? [];
    for (const match of matches) {
      const term = match.trim();
      if (term.length > 2) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      }
    }
  }

  return Array.from(termCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);
}

// --- Long text splitting ---

export function splitLongText(text: string, maxTokens: number = 4000): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const sentences = text.split(/(?<=[.?!。？！])\s+/);
  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (estimateTokens(current + ' ' + sentence) > maxTokens && current) {
      parts.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.length > 0 ? parts : [text];
}

// --- Main content extraction ---

export interface ExtractedParagraph {
  element: Element;
  text: string;
  codeMap: Map<string, string>;
}

export async function findMainContainer(): Promise<Element> {
  try {
    const result = await Promise.race([
      new Promise<{ content: string; debug?: { contentSelector?: string } }>((resolve) => {
        const docClone = document.cloneNode(true) as Document;
        const parsed = new Defuddle(docClone, { debug: true }).parse();
        resolve(parsed);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('defuddle timeout')), DEFUDDLE_TIMEOUT_MS)
      ),
    ]);

    if (result.debug?.contentSelector) {
      const container = document.querySelector(result.debug.contentSelector);
      if (container) return container;
    }

    if (result.content) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = result.content;
      const fingerprint = (tempDiv.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (fingerprint.length > 50) {
        const found = findContainerByFingerprint(document.body, fingerprint);
        if (found) return found;
      }
    }
  } catch {
    // defuddle failed or timed out, fallback to body
  }

  return document.body;
}

function findContainerByFingerprint(root: Element, fingerprint: string): Element | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let bestMatch: Element | null = null;
  let bestLength = Infinity;

  let node: Node | null = walker.currentNode;
  while (node) {
    if (node instanceof Element) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.includes(fingerprint) && text.length < bestLength) {
        bestMatch = node;
        bestLength = text.length;
      }
    }
    node = walker.nextNode();
  }

  return bestMatch;
}

// --- Paragraph collection ---

export function collectParagraphs(container: Element, translatedSet: Set<Element>): ExtractedParagraph[] {
  const paragraphs: ExtractedParagraph[] = [];
  const visited = new Set<Element>();

  function walk(el: Element) {
    if (shouldSkipElement(el)) return;
    if (translatedSet.has(el)) return;

    if (PARAGRAPH_TAGS.has(el.tagName)) {
      const hasChildParagraph = Array.from(el.children).some(child => PARAGRAPH_TAGS.has(child.tagName));
      if (!hasChildParagraph && !visited.has(el)) {
        visited.add(el);
        const { text, codeMap } = extractTextWithCodeProtection(el);
        const trimmed = text.trim();
        if (trimmed.length >= MIN_TEXT_LENGTH && trimmed.length <= MAX_TEXT_LENGTH) {
          paragraphs.push({ element: el, text: trimmed, codeMap });
        }
      }
    }

    for (const child of el.children) {
      walk(child);
    }
  }

  walk(container);
  return paragraphs;
}
