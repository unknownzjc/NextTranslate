import type { ToggleTranslateResponse, TranslateStatusMsg } from '@shared/messages';
import { loadProviderConfig } from '@shared/storage';
import { findMainContainer } from './extractor';
import { getMainDomain } from './compat';
import { Translator } from './translator';
import { Injector } from './injector';
import { ProgressBar } from './progress';

// --- State ---

type TranslateState = 'idle' | 'translating' | 'done';

const RESTORE_VIEWPORT_MARGIN_PX = 320;
const VIEWPORT_TRANSLATION_MARGIN_PX = 520;
const RESTORE_BATCH_LIMIT = 12;
const DOM_WORK_DEBOUNCE_MS = 180;
const SCROLL_IDLE_MS = 140;

let state: TranslateState = 'idle';
let translationsVisible = true;
let toggleBusy = false;
let mutationObserver: MutationObserver | null = null;
let domWorkTimer: ReturnType<typeof setTimeout> | null = null;
let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
let mainContainer: Element | null = null;
let pendingIncrementalTranslation = false;
let pendingNewContent = false;
let domWorkInProgress = false;
let isScrollActive = false;
let latestProgress = { completed: 0, total: 0 };
const pendingRestoreIds = new Set<string>();

const injector = new Injector();
const progressBar = new ProgressBar();
const useViewportLazyTranslation = getMainDomain(location.hostname) === 'x.com';

function reportTranslateStatus(
  status: TranslateStatusMsg['status'],
  progress?: { completed: number; total: number },
  error?: string,
) {
  if (status === 'cancelled') return;

  try {
    chrome.runtime.sendMessage({
      type: 'REPORT_TRANSLATE_STATUS',
      status,
      progress,
      error,
    }).catch(() => {});
  } catch {
    // Background may be unavailable during extension reload.
  }
}

function getNavigationKey(url = location.href): string {
  try {
    const parsed = new URL(url, location.href);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return location.origin + location.pathname + location.search;
  }
}

const translator = new Translator({
  onBatchTranslated: (_, elements, translations) => {
    for (let i = 0; i < elements.length; i++) {
      injector.insertTranslation(elements[i], translations[i]);
    }
  },
  onProgress: (completed, total) => {
    latestProgress = { completed, total };
    progressBar.update(completed, total);
    reportTranslateStatus('translating', latestProgress);
  },
  onComplete: () => {
    if (pendingIncrementalTranslation && mainContainer) {
      pendingIncrementalTranslation = false;
      void startIncrementalTranslation();
      return;
    }

    state = 'done';
    progressBar.complete();
    reportTranslateStatus('done', latestProgress);
  },
  onError: (error) => {
    progressBar.error(error);
    reportTranslateStatus('error', latestProgress, error);
  },
  onCancelled: () => {
    state = 'idle';
    progressBar.hide();
  },
});

// --- Message listener ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TOGGLE_TRANSLATE') {
    const response = handleToggle();
    sendResponse(response);
  }
});

function handleToggle(): ToggleTranslateResponse {
  if (toggleBusy) return { action: 'busy' };

  toggleBusy = true;
  try {
    switch (state) {
      case 'idle':
        startTranslation();
        return { action: 'started' };

      case 'translating':
        cancelTranslation();
        return { action: 'cancelled' };

      case 'done':
        translationsVisible = !translationsVisible;
        injector.setVisibility(translationsVisible);
        return { action: translationsVisible ? 'toggled_visible' : 'toggled_hidden' };
    }
  } finally {
    toggleBusy = false;
  }
}

// --- Translation flow ---

function getTranslationIncludeElement(): ((el: Element) => boolean) | undefined {
  if (!useViewportLazyTranslation) return undefined;
  return (el: Element) => isNearViewport(el, VIEWPORT_TRANSLATION_MARGIN_PX);
}

async function runTranslationPass() {
  if (!mainContainer) return false;

  const config = await loadProviderConfig();
  injector.setTargetLanguage(config.targetLanguage);

  const includeElement = getTranslationIncludeElement();
  if (!translator.hasPendingWork(mainContainer, { includeElement })) {
    return false;
  }

  state = 'translating';
  latestProgress = { completed: 0, total: 0 };
  progressBar.show();
  await translator.start(mainContainer, config.targetLanguage, { includeElement });
  return true;
}

async function startTranslation() {
  state = 'translating';
  translationsVisible = true;
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  pendingRestoreIds.clear();
  injector.setVisibility(true);

  mainContainer = await findMainContainer();
  injector.detectTheme(mainContainer);

  const started = await runTranslationPass();
  if (!started) {
    state = 'done';
    reportTranslateStatus('done', latestProgress);
  }

  startObserver();
}

async function startIncrementalTranslation() {
  if (!mainContainer) return false;

  pendingNewContent = false;
  return runTranslationPass();
}

function cancelTranslation() {
  state = 'idle';
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  pendingRestoreIds.clear();
  translator.cancel();
  injector.hideAll();
  stopObserver();
}

// --- Deferred DOM work ---

function scheduleDomWork(delay = DOM_WORK_DEBOUNCE_MS) {
  if (domWorkTimer) clearTimeout(domWorkTimer);
  domWorkTimer = setTimeout(() => {
    domWorkTimer = null;
    void flushDomWork();
  }, delay);
}

async function flushDomWork() {
  if (domWorkInProgress || isScrollActive || !mainContainer) return;

  domWorkInProgress = true;
  try {
    restorePendingTranslationsNearViewport();

    const shouldTryIncremental = pendingNewContent || (useViewportLazyTranslation && state === 'done');
    if (!shouldTryIncremental) return;

    if (state === 'translating') {
      pendingIncrementalTranslation = true;
      pendingNewContent = false;
      return;
    }

    if (state !== 'done') return;

    pendingNewContent = false;
    await startIncrementalTranslation();
  } finally {
    domWorkInProgress = false;
    if ((pendingRestoreIds.size > 0 || pendingNewContent) && !isScrollActive) {
      scheduleDomWork();
    }
  }
}

function restorePendingTranslationsNearViewport() {
  if (pendingRestoreIds.size === 0) return;

  const idsToRestore: string[] = [];
  const idsToDrop: string[] = [];

  for (const ntId of pendingRestoreIds) {
    const sourceEl = injector.getSourceElementByTranslationId(ntId);
    if (!sourceEl || !sourceEl.isConnected) {
      idsToDrop.push(ntId);
      continue;
    }

    if (isNearViewport(sourceEl)) {
      idsToRestore.push(ntId);
      if (idsToRestore.length >= RESTORE_BATCH_LIMIT) break;
    }
  }

  for (const ntId of idsToDrop) {
    pendingRestoreIds.delete(ntId);
  }

  if (idsToRestore.length === 0) return;

  const anchor = captureViewportAnchor();

  for (const ntId of idsToRestore) {
    const restored = injector.restoreTranslationById(ntId);
    pendingRestoreIds.delete(ntId);
    if (!restored) continue;
  }

  if (anchor?.element.isConnected) {
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) >= 1) {
      window.scrollBy(0, delta);
    }
  }
}

function isNearViewport(el: Element, margin = RESTORE_VIEWPORT_MARGIN_PX): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom >= -margin
    && rect.top <= window.innerHeight + margin;
}

function captureViewportAnchor(): { element: Element; top: number } | null {
  if (window.innerWidth <= 0 || window.innerHeight <= 0) return null;

  const x = Math.min(Math.max(Math.round(window.innerWidth / 2), 1), Math.max(window.innerWidth - 1, 1));
  const y = Math.min(Math.max(Math.round(Math.min(window.innerHeight * 0.25, 160)), 1), Math.max(window.innerHeight - 1, 1));

  let anchor = document.elementFromPoint(x, y);
  while (anchor && (anchor.classList.contains('nt-translation') || anchor.classList.contains('nt-progress-container'))) {
    anchor = anchor.parentElement;
  }

  return anchor && anchor.isConnected
    ? { element: anchor, top: anchor.getBoundingClientRect().top }
    : null;
}

function collectRemovedTranslationIds(node: Node) {
  if (!(node instanceof Element)) return;

  const candidates: Element[] = [];
  if (node.matches('.nt-translation[data-nt-id]')) {
    candidates.push(node);
  }
  candidates.push(...node.querySelectorAll('.nt-translation[data-nt-id]'));

  for (const candidate of candidates) {
    const ntId = candidate.getAttribute('data-nt-id');
    if (ntId) {
      pendingRestoreIds.add(ntId);
    }
  }
}

function handleScroll() {
  if (pendingRestoreIds.size === 0 && !pendingNewContent && !useViewportLazyTranslation) return;

  isScrollActive = true;
  if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
  scrollIdleTimer = setTimeout(() => {
    isScrollActive = false;
    void flushDomWork();
  }, SCROLL_IDLE_MS);
}

window.addEventListener('scroll', handleScroll, { passive: true });

// --- MutationObserver ---

function startObserver() {
  if (!mainContainer || mutationObserver) return;

  mutationObserver = new MutationObserver((mutations) => {
    let hasNewContent = false;

    for (const m of mutations) {
      if (m.type === 'characterData') {
        const parent = m.target.parentElement;
        if (parent && !parent.closest('.nt-translation')) {
          hasNewContent = true;
        }
        continue;
      }

      for (const node of m.addedNodes) {
        if (node instanceof Element && !node.className?.split?.(' ').some((c: string) => c.startsWith('nt-'))) {
          hasNewContent = true;
        }
      }
      for (const node of m.removedNodes) {
        collectRemovedTranslationIds(node);
      }
    }

    if (hasNewContent) {
      pendingNewContent = true;
    }

    if (pendingRestoreIds.size > 0 || hasNewContent) {
      scheduleDomWork();
    }
  });

  mutationObserver.observe(mainContainer, { childList: true, characterData: true, subtree: true });
}

function stopObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  if (domWorkTimer) {
    clearTimeout(domWorkTimer);
    domWorkTimer = null;
  }
  if (scrollIdleTimer) {
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
  }
  isScrollActive = false;
}

// --- SPA navigation ---

let currentNavigationKey = getNavigationKey();

function handleSpaNavigation(nextUrl?: string) {
  const nextNavigationKey = getNavigationKey(nextUrl);
  if (nextNavigationKey === currentNavigationKey) return;
  currentNavigationKey = nextNavigationKey;

  if (state === 'translating') {
    cancelTranslation();
  }

  state = 'idle';
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  pendingRestoreIds.clear();
  injector.removeAll();
  translator.resetState();
  stopObserver();
  mainContainer = null;
}

window.addEventListener('popstate', () => handleSpaNavigation());

const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function (...args) {
  originalPushState.apply(this, args);
  handleSpaNavigation(typeof args[2] === 'string' || args[2] instanceof URL ? String(args[2]) : undefined);
};

history.replaceState = function (...args) {
  originalReplaceState.apply(this, args);
  handleSpaNavigation(typeof args[2] === 'string' || args[2] instanceof URL ? String(args[2]) : undefined);
};

console.log('[NextTranslate] Content script injected');
