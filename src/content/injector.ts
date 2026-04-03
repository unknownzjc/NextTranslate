// Elements whose parent has strict child constraints (e.g. <tr> only allows <td>/<th>).
// Translation must be appended inside these elements rather than inserted as a sibling.
const APPEND_INSIDE_TAGS = new Set(['TD', 'TH', 'LI', 'DD', 'DT', 'FIGCAPTION']);

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

    let translationDiv: HTMLElement | null = null;
    const isAppendInside = APPEND_INSIDE_TAGS.has(sourceEl.tagName);

    if (isAppendInside) {
      // For append-inside elements, check last child
      const lastChild = sourceEl.lastElementChild;
      if (lastChild?.classList.contains('nt-translation') &&
          lastChild.getAttribute('data-nt-id') === ntId) {
        translationDiv = lastChild as HTMLElement;
      }
    } else {
      const nextSibling = sourceEl.nextElementSibling;
      if (nextSibling?.classList.contains('nt-translation') &&
          nextSibling.getAttribute('data-nt-id') === ntId) {
        translationDiv = nextSibling as HTMLElement;
      }
    }

    if (!translationDiv) {
      translationDiv = document.createElement('div');
      translationDiv.className = 'nt-translation';
      translationDiv.setAttribute('data-nt', '');
      translationDiv.setAttribute('data-nt-id', ntId);
      translationDiv.setAttribute('data-nt-theme', this.theme);
      translationDiv.setAttribute('lang', LANG_MAP[this.targetLanguage] ?? 'zh-CN');

      if (APPEND_INSIDE_TAGS.has(sourceEl.tagName)) {
        // Append inside to avoid breaking parent structure (e.g. <tr>, <ul>)
        sourceEl.appendChild(translationDiv);
      } else {
        sourceEl.parentNode?.insertBefore(translationDiv, sourceEl.nextSibling);
      }
      this.translationElements.add(translationDiv);
    }

    // Use textContent (XSS safe)
    translationDiv.textContent = translatedText;

    this.translationMap.set(ntId, {
      sourceEl: new WeakRef(sourceEl),
      translatedText,
    });
  }

  setVisibility(visible: boolean) {
    for (const el of this.translationElements) {
      el.style.display = visible ? '' : 'none';
    }
  }

  hideAll() {
    this.setVisibility(false);
  }

  removeAll() {
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

  restoreRemovedTranslations() {
    for (const [ntId, data] of this.translationMap) {
      const sourceEl = data.sourceEl.deref();
      if (!sourceEl || !sourceEl.isConnected) continue;

      if (APPEND_INSIDE_TAGS.has(sourceEl.tagName)) {
        const lastChild = sourceEl.lastElementChild;
        if (lastChild?.classList.contains('nt-translation') &&
            lastChild.getAttribute('data-nt-id') === ntId) {
          continue;
        }
      } else {
        const existing = sourceEl.nextElementSibling;
        if (existing?.classList.contains('nt-translation') &&
            existing.getAttribute('data-nt-id') === ntId) {
          continue;
        }
      }

      this.insertTranslation(sourceEl, data.translatedText);
    }
  }
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
