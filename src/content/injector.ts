// Append inside the source element for most translated blocks to reduce sibling layout churn.
const APPEND_INSIDE_TAGS = new Set([
  'P',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION', 'DT', 'DD',
  'DIV', 'LABEL', 'ARTICLE', 'SECTION', 'MAIN', 'ASIDE',
]);

const LANG_MAP: Record<string, string> = {
  'Simplified Chinese': 'zh-CN',
  'Traditional Chinese': 'zh-TW',
  'Japanese': 'ja',
  'Korean': 'ko',
  'English': 'en',
};

export class Injector {
  private ntIdCounter = 0;
  private translationMap = new Map<string, { sourceEl: WeakRef<Element>; translatedText: string }>();
  private translationElements = new Set<HTMLElement>();
  private theme: 'light' | 'dark' = 'light';
  private targetLanguage = 'Simplified Chinese';
  private visible = true;

  setTargetLanguage(lang: string) {
    this.targetLanguage = lang;
  }

  detectTheme(container: Element) {
    let el: Element | null = container;
    while (el) {
      const style = getComputedStyle(el);
      const bg = style.backgroundColor;
      const alpha = parseAlpha(bg);
      if (alpha > 0) {
        const luminance = computeLuminance(bg);
        this.theme = luminance > 0.5 ? 'light' : 'dark';
        return;
      }
      el = el.parentElement;
    }
    this.theme = 'light';
  }

  insertTranslation(sourceEl: Element, translatedText: string) {
    let ntId = sourceEl.getAttribute('data-nt-id');
    if (!ntId) {
      ntId = String(this.ntIdCounter++);
      sourceEl.setAttribute('data-nt-id', ntId);
    }

    let translationEl = this.findExistingTranslation(sourceEl, ntId);

    if (!translationEl) {
      translationEl = document.createElement('span');
      translationEl.className = 'nt-translation';
      translationEl.setAttribute('data-nt', '');
      translationEl.setAttribute('data-nt-id', ntId);
      translationEl.setAttribute('data-nt-theme', this.theme);
      translationEl.setAttribute('lang', LANG_MAP[this.targetLanguage] ?? 'zh-CN');
      translationEl.style.display = this.visible ? '' : 'none';

      if (shouldAppendInside(sourceEl)) {
        sourceEl.appendChild(translationEl);
      } else {
        sourceEl.parentNode?.insertBefore(translationEl, sourceEl.nextSibling);
      }
      this.translationElements.add(translationEl);
    }

    translationEl.textContent = translatedText;

    this.translationMap.set(ntId, {
      sourceEl: new WeakRef(sourceEl),
      translatedText,
    });
  }

  setVisibility(visible: boolean) {
    this.visible = visible;
    this.pruneDetachedTranslations();

    for (const el of this.translationElements) {
      el.style.display = visible ? '' : 'none';
    }
  }

  hideAll() {
    this.setVisibility(false);
  }

  removeAll() {
    this.pruneDetachedTranslations();

    for (const el of this.translationElements) {
      el.remove();
    }
    this.translationElements.clear();
    this.translationMap.clear();
    document.querySelectorAll('[data-nt-id]').forEach(el => {
      if (!el.classList.contains('nt-translation')) {
        el.removeAttribute('data-nt-id');
      }
    });
  }

  restoreTranslationById(ntId: string): boolean {
    const data = this.translationMap.get(ntId);
    const sourceEl = data?.sourceEl.deref();
    if (!data || !sourceEl || !sourceEl.isConnected) return false;

    this.insertTranslation(sourceEl, data.translatedText);
    return true;
  }

  getSourceElementByTranslationId(ntId: string): Element | null {
    return this.translationMap.get(ntId)?.sourceEl.deref() ?? null;
  }

  private findExistingTranslation(sourceEl: Element, ntId: string): HTMLElement | null {
    if (shouldAppendInside(sourceEl)) {
      const existing = sourceEl.querySelector(`:scope > .nt-translation[data-nt-id="${CSS.escape(ntId)}"]`);
      return existing instanceof HTMLElement ? existing : null;
    }

    const nextSibling = sourceEl.nextElementSibling;
    if (nextSibling?.classList.contains('nt-translation') && nextSibling.getAttribute('data-nt-id') === ntId) {
      return nextSibling as HTMLElement;
    }

    return null;
  }

  private pruneDetachedTranslations() {
    for (const el of this.translationElements) {
      if (!el.isConnected) {
        this.translationElements.delete(el);
      }
    }
  }
}

function shouldAppendInside(sourceEl: Element): boolean {
  return APPEND_INSIDE_TAGS.has(sourceEl.tagName) || sourceEl.tagName.includes('-');
}

function parseAlpha(color: string): number {
  if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return 0;
  const match = color.match(/rgba?\([\d.]+,\s*[\d.]+,\s*[\d.]+(?:,\s*([\d.]+))?\)/);
  if (match) return match[1] !== undefined ? parseFloat(match[1]) : 1;
  return 1;
}

function computeLuminance(color: string): number {
  const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!match) return 1;
  const [r, g, b] = [parseFloat(match[1]) / 255, parseFloat(match[2]) / 255, parseFloat(match[3]) / 255];
  const linearize = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}
