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
  private translationElements = new Set<HTMLElement>();
  private pendingDotsElements = new Set<HTMLElement>();
  private retryMarkerElements = new Set<HTMLElement>();
  private theme: 'light' | 'dark' = 'light';
  private targetLanguage = 'Simplified Chinese';
  private visible = true;
  private currentScope: 'segment' | 'page' | null = null;
  private retryHandler: ((sourceEl: Element) => void) | null = null;
  setScope(scope: 'segment' | 'page') {
    this.currentScope = scope;
  }

  setTargetLanguage(lang: string) {
    this.targetLanguage = lang;
  }

  setRetryHandler(handler: ((sourceEl: Element) => void) | null) {
    this.retryHandler = handler;
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
    const ntId = this.ensureNtId(sourceEl);
    const hostEl = getTranslationHost(sourceEl);
    let translationEl = this.findExistingTranslation(sourceEl, ntId);

    this.clearRetryMarker(sourceEl);

    if (!translationEl) {
      translationEl = document.createElement('span');
      translationEl.className = 'nt-translation';
      translationEl.setAttribute('data-nt', '');
      translationEl.setAttribute('data-nt-id', ntId);
      translationEl.setAttribute('data-nt-theme', this.theme);
      translationEl.setAttribute('lang', LANG_MAP[this.targetLanguage] ?? 'zh-CN');
      const translationKind = getTranslationKind(sourceEl);
      if (translationKind) {
        translationEl.setAttribute('data-nt-kind', translationKind);
      }
      if (this.currentScope) {
        translationEl.setAttribute('data-nt-scope', this.currentScope);
      }
      this.applyVisibility(translationEl);

      if (shouldAppendInside(hostEl)) {
        hostEl.appendChild(translationEl);
      } else {
        hostEl.parentNode?.insertBefore(translationEl, hostEl.nextSibling);
      }
      this.translationElements.add(translationEl);
    }

    // Transition from loading skeleton to real text
    if (translationEl.classList.contains('nt-loading')) {
      translationEl.classList.remove('nt-loading');
      translationEl.classList.add('nt-reveal');
      setTimeout(() => translationEl!.classList.remove('nt-reveal'), 300);
    }

    translationEl.textContent = translatedText;
    this.clearPendingDots(sourceEl);
  }

  showLoadingPlaceholder(sourceEl: Element) {
    const ntId = this.ensureNtId(sourceEl);
    const hostEl = getTranslationHost(sourceEl);
    const dotsHost = getDotsHost(sourceEl);

    this.clearRetryMarker(sourceEl);

    // Don't double-insert if already a placeholder or real translation
    if (this.findExistingTranslation(sourceEl, ntId)) return;

    const translationKind = getTranslationKind(sourceEl);

    // 1. Append animated dots at the end of the visual title/label area
    const dotsEl = document.createElement('span');
    dotsEl.className = 'nt-pending-dots';
    dotsEl.setAttribute('data-nt', '');
    dotsEl.setAttribute('data-nt-theme', this.theme);
    if (translationKind) {
      dotsEl.setAttribute('data-nt-kind', translationKind);
    }
    dotsEl.textContent = '···';
    dotsHost.appendChild(dotsEl);
    this.pendingDotsElements.add(dotsEl);

    // 2. Insert shimmer skeleton placeholder at the translation position
    const placeholderEl = document.createElement('span');
    placeholderEl.className = 'nt-translation nt-loading';
    placeholderEl.setAttribute('data-nt', '');
    placeholderEl.setAttribute('data-nt-id', ntId);
    placeholderEl.setAttribute('data-nt-theme', this.theme);
    placeholderEl.setAttribute('lang', LANG_MAP[this.targetLanguage] ?? 'zh-CN');
    if (translationKind) {
      placeholderEl.setAttribute('data-nt-kind', translationKind);
    }
    if (this.currentScope) {
      placeholderEl.setAttribute('data-nt-scope', this.currentScope);
    }
    this.applyVisibility(placeholderEl);

    if (shouldAppendInside(hostEl)) {
      hostEl.appendChild(placeholderEl);
    } else {
      hostEl.parentNode?.insertBefore(placeholderEl, hostEl.nextSibling);
    }
    this.translationElements.add(placeholderEl);
  }

  showRetryMarker(sourceEl: Element) {
    const ntId = this.ensureNtId(sourceEl);
    const dotsHost = getDotsHost(sourceEl);
    const translationKind = getTranslationKind(sourceEl);

    this.clearPendingDots(sourceEl);
    this.removeLoadingPlaceholder(sourceEl, ntId);

    let retryEl = this.findRetryMarker(sourceEl, ntId);
    if (!retryEl) {
      retryEl = document.createElement('button');
      retryEl.type = 'button';
      retryEl.className = 'nt-retry-marker';
      retryEl.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.retryHandler?.(sourceEl);
      });
      this.retryMarkerElements.add(retryEl);
    }

    retryEl.setAttribute('data-nt', '');
    retryEl.setAttribute('data-nt-id', ntId);
    retryEl.setAttribute('data-nt-theme', this.theme);
    retryEl.setAttribute('title', '重试翻译此段');
    retryEl.setAttribute('aria-label', '重试翻译此段');
    if (translationKind) {
      retryEl.setAttribute('data-nt-kind', translationKind);
    } else {
      retryEl.removeAttribute('data-nt-kind');
    }
    retryEl.textContent = '↻';
    this.applyVisibility(retryEl);
    dotsHost.appendChild(retryEl);
  }

  clearRetryMarker(sourceEl: Element) {
    const ntId = sourceEl.getAttribute('data-nt-id');
    if (!ntId) return;

    const retryEl = this.findRetryMarker(sourceEl, ntId);
    if (!retryEl) return;

    this.retryMarkerElements.delete(retryEl);
    retryEl.remove();
  }

  clearLoadingIndicators() {
    this.clearPendingLoadingIndicators();

    for (const el of this.retryMarkerElements) el.remove();
    this.retryMarkerElements.clear();
  }

  setVisibility(visible: boolean) {
    this.visible = visible;
    this.pruneDetachedTranslations();
    this.pruneDetachedRetryMarkers();

    if (!visible) {
      this.clearPendingLoadingIndicators();
    }

    for (const el of this.translationElements) {
      this.applyVisibility(el);
    }

    for (const el of this.retryMarkerElements) {
      this.applyVisibility(el);
    }
  }

  hideAll() {
    this.setVisibility(false);
  }

  removeAll() {
    this.clearLoadingIndicators();
    this.pruneDetachedTranslations();
    this.pruneDetachedRetryMarkers();

    for (const el of this.translationElements) {
      el.remove();
    }
    this.translationElements.clear();
    document.querySelectorAll('[data-nt-id]').forEach(el => {
      if (!el.classList.contains('nt-translation')) {
        el.removeAttribute('data-nt-id');
      }
    });
  }

  hasTranslation(sourceEl: Element): boolean {
    const ntId = sourceEl.getAttribute('data-nt-id');
    if (!ntId) return false;

    const hostEl = getExistingTranslationHost(sourceEl);
    if (shouldAppendInside(hostEl)) {
      const existing = hostEl.querySelector(`:scope > .nt-translation[data-nt-id="${CSS.escape(ntId)}"]`);
      return existing instanceof HTMLElement;
    }

    const nextSibling = hostEl.nextElementSibling;
    return Boolean(
      nextSibling?.classList.contains('nt-translation')
        && nextSibling.getAttribute('data-nt-id') === ntId,
    );
  }

  private findExistingTranslation(sourceEl: Element, ntId: string): HTMLElement | null {
    const hostEl = getTranslationHost(sourceEl);

    if (shouldAppendInside(hostEl)) {
      const existing = hostEl.querySelector(`:scope > .nt-translation[data-nt-id="${CSS.escape(ntId)}"]`);
      return existing instanceof HTMLElement ? existing : null;
    }

    const nextSibling = hostEl.nextElementSibling;
    if (nextSibling?.classList.contains('nt-translation') && nextSibling.getAttribute('data-nt-id') === ntId) {
      return nextSibling as HTMLElement;
    }

    return null;
  }

  private findRetryMarker(sourceEl: Element, ntId: string): HTMLButtonElement | null {
    const retryEl = getDotsHost(sourceEl).querySelector(`:scope > .nt-retry-marker[data-nt-id="${CSS.escape(ntId)}"]`);
    return retryEl instanceof HTMLButtonElement ? retryEl : null;
  }

  private ensureNtId(sourceEl: Element): string {
    let ntId = sourceEl.getAttribute('data-nt-id');
    if (!ntId) {
      ntId = String(this.ntIdCounter++);
      sourceEl.setAttribute('data-nt-id', ntId);
    }
    return ntId;
  }

  private clearPendingDots(sourceEl: Element) {
    const dotsEl = getDotsHost(sourceEl).querySelector(':scope > .nt-pending-dots[data-nt]');
    if (!dotsEl) return;

    this.pendingDotsElements.delete(dotsEl as HTMLElement);
    dotsEl.remove();
  }

  private removeLoadingPlaceholder(sourceEl: Element, ntId: string) {
    const existingTranslation = this.findExistingTranslation(sourceEl, ntId);
    if (!(existingTranslation instanceof HTMLElement) || !existingTranslation.classList.contains('nt-loading')) return;

    this.translationElements.delete(existingTranslation);
    existingTranslation.remove();
  }

  private clearPendingLoadingIndicators() {
    for (const el of this.pendingDotsElements) el.remove();
    this.pendingDotsElements.clear();

    const stalePlaceholders: HTMLElement[] = [];
    for (const el of this.translationElements) {
      if (el.classList.contains('nt-loading')) {
        stalePlaceholders.push(el);
        continue;
      }
      el.classList.remove('nt-reveal');
    }

    for (const el of stalePlaceholders) {
      this.translationElements.delete(el);
      el.remove();
    }
  }

  private applyVisibility(el: HTMLElement) {
    if (this.visible) {
      el.style.removeProperty('display');
      return;
    }

    el.style.setProperty('display', 'none', 'important');
  }

  private pruneDetachedTranslations() {
    for (const el of this.translationElements) {
      if (!el.isConnected) {
        this.translationElements.delete(el);
      }
    }
  }

  private pruneDetachedRetryMarkers() {
    for (const el of this.retryMarkerElements) {
      if (!el.isConnected) {
        this.retryMarkerElements.delete(el);
      }
    }
  }
}

function shouldAppendInside(sourceEl: Element): boolean {
  return APPEND_INSIDE_TAGS.has(sourceEl.tagName) || sourceEl.tagName.includes('-');
}

function getTranslationKind(sourceEl: Element): string | null {
  if (sourceEl.matches('span.titleline > a, td.title a.titlelink')) {
    return 'hn-title';
  }

  return null;
}

function getTranslationHost(sourceEl: Element): Element {
  if (sourceEl.matches('[data-listview-item-title-container] > h3')) {
    return sourceEl.parentElement ?? sourceEl;
  }

  if (sourceEl.matches('bdi[data-testid="issue-title"], h1[data-component="PH_Title"] > span.markdown-title')) {
    return sourceEl.closest('h1[data-component="PH_Title"]') ?? sourceEl.parentElement ?? sourceEl;
  }

  if (sourceEl.matches('a.markdown-title[href*="/pull/"]')) {
    return ensureGitHubPullListTitleHost(sourceEl);
  }

  if (sourceEl.matches('span.titleline > a, td.title a.titlelink')) {
    return sourceEl.closest('td.title') ?? sourceEl.parentElement ?? sourceEl;
  }

  return sourceEl;
}

function getDotsHost(sourceEl: Element): Element {
  return getTranslationHost(sourceEl);
}

function getExistingTranslationHost(sourceEl: Element): Element {
  if (sourceEl.matches('[data-listview-item-title-container] > h3')) {
    return sourceEl.parentElement ?? sourceEl;
  }

  if (sourceEl.matches('bdi[data-testid="issue-title"], h1[data-component="PH_Title"] > span.markdown-title')) {
    return sourceEl.closest('h1[data-component="PH_Title"]') ?? sourceEl.parentElement ?? sourceEl;
  }

  if (sourceEl.matches('a.markdown-title[href*="/pull/"]')) {
    return sourceEl.closest('.nt-github-pr-title-line') ?? sourceEl.parentElement ?? sourceEl;
  }

  if (sourceEl.matches('span.titleline > a, td.title a.titlelink')) {
    return sourceEl.closest('td.title') ?? sourceEl.parentElement ?? sourceEl;
  }

  return sourceEl;
}

function ensureGitHubPullListTitleHost(sourceEl: Element): Element {
  const existingHost = sourceEl.closest('.nt-github-pr-title-line');
  if (existingHost) return existingHost;

  const parent = sourceEl.parentElement;
  if (!parent) return sourceEl;

  const wrapper = document.createElement('div');
  wrapper.className = 'nt-github-pr-title-line';
  parent.insertBefore(wrapper, sourceEl);

  let current: ChildNode | null = sourceEl;
  while (current) {
    const next: ChildNode | null = current.nextSibling;

    if (current instanceof HTMLElement && shouldStopPullTitleGrouping(current)) {
      break;
    }

    wrapper.appendChild(current);
    current = next;
  }

  return wrapper;
}

function shouldStopPullTitleGrouping(el: HTMLElement): boolean {
  if (el.classList.contains('nt-github-pr-title-line')) return false;
  if (el.matches('div, p, ul, ol, dl, table, section, article, aside, nav')) return true;
  return false;
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
