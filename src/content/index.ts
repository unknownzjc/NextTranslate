import type { ToggleTranslateResponse, TranslateStatusMsg } from '@shared/messages';
import { loadProviderConfig } from '@shared/storage';
import { findMainContainer } from './extractor';
import { getMainDomain } from './compat';
import { Translator } from './translator';
import { Injector } from './injector';
import { ProgressBar } from './progress';

// --- State ---

type TranslateState = 'idle' | 'translating' | 'done';

const VIEWPORT_TRANSLATION_MARGIN_PX = 520;
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

const injector = new Injector();
const progressBar = new ProgressBar();
const useViewportLazyTranslation = getMainDomain(location.hostname) === 'x.com';

function markTranslationDone() {
  state = 'done';
  progressBar.complete();
  reportTranslateStatus('done', latestProgress);
}

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
  onBlocksQueued: (elements) => {
    for (const el of elements) {
      injector.showLoadingPlaceholder(el);
    }
  },
  onComplete: () => {
    if (pendingIncrementalTranslation && mainContainer) {
      pendingIncrementalTranslation = false;
      void startIncrementalTranslation().then(started => {
        if (!started) {
          markTranslationDone();
        }
      });
      return;
    }

    markTranslationDone();
  },
  onError: (error) => {
    injector.clearLoadingIndicators();
    progressBar.error(error);
    reportTranslateStatus('error', latestProgress, error);
  },
  onCancelled: () => {
    state = 'idle';
    injector.clearLoadingIndicators();
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

function shouldSkipRenderedElement(el: Element): boolean {
  return injector.hasTranslation(el);
}

async function ensureMainContainerReady(): Promise<boolean> {
  if (mainContainer?.isConnected) return true;

  const nextContainer = await findMainContainer();
  if (!nextContainer) return false;

  const containerChanged = nextContainer !== mainContainer;
  if (containerChanged && mutationObserver) {
    stopObserver();
  }

  mainContainer = nextContainer;
  injector.detectTheme(mainContainer);

  if (state !== 'idle' && !mutationObserver) {
    startObserver();
  }

  return true;
}

async function runTranslationPass() {
  const ready = await ensureMainContainerReady();
  if (!ready || !mainContainer) return false;

  const config = await loadProviderConfig();
  injector.setTargetLanguage(config.targetLanguage);

  const includeElement = getTranslationIncludeElement();
  const options = { includeElement, shouldSkipElement: shouldSkipRenderedElement };
  if (!translator.hasPendingWork(mainContainer, options)) {
    return false;
  }

  state = 'translating';
  latestProgress = { completed: 0, total: 0 };
  progressBar.show();
  await translator.start(mainContainer, config.targetLanguage, options);
  return true;
}

async function startTranslation() {
  state = 'translating';
  translationsVisible = true;
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  injector.setVisibility(true);

  const started = await runTranslationPass();
  if (!started) {
    markTranslationDone();
  }

  startObserver();
}

async function startIncrementalTranslation() {
  pendingNewContent = false;
  return runTranslationPass();
}

function cancelTranslation() {
  state = 'idle';
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
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
  if (domWorkInProgress || isScrollActive) return;

  const ready = await ensureMainContainerReady();
  if (!ready || !mainContainer) return;

  domWorkInProgress = true;
  try {
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
    if (pendingNewContent && !isScrollActive) {
      scheduleDomWork();
    }
  }
}

function isNearViewport(el: Element, margin = VIEWPORT_TRANSLATION_MARGIN_PX): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom >= -margin
    && rect.top <= window.innerHeight + margin;
}

function hasRemovedTranslationNode(node: Node): boolean {
  return node instanceof Element
    && (node.matches('.nt-translation[data-nt-id]')
      || node.querySelector('.nt-translation[data-nt-id]') !== null);
}

function isObservedMutationRelevant(target: Element): boolean {
  if (!mainContainer) return false;
  return !mainContainer.isConnected || mainContainer.contains(target) || target.contains(mainContainer);
}

function isNextTranslateElement(node: Element): boolean {
  return node.matches('[data-nt], .nt-progress-container, .nt-orphan-banner')
    || node.closest('[data-nt], .nt-progress-container, .nt-orphan-banner') !== null;
}

function handleScroll() {
  if (mainContainer && !mainContainer.isConnected) {
    pendingNewContent = true;
    scheduleDomWork(0);
  }

  if (!pendingNewContent && !useViewportLazyTranslation) return;

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
    let removedTranslationNode = false;

    for (const m of mutations) {
      const mutationTarget = m.target instanceof Element ? m.target : m.target.parentElement;
      if (!mutationTarget || !isObservedMutationRelevant(mutationTarget)) continue;

      if (m.type === 'characterData') {
        const parent = m.target.parentElement;
        if (parent && !parent.closest('.nt-translation') && !isNextTranslateElement(parent)) {
          hasNewContent = true;
        }
        continue;
      }

      for (const node of m.addedNodes) {
        if (node instanceof Element && !isNextTranslateElement(node)) {
          hasNewContent = true;
        }
      }
      for (const node of m.removedNodes) {
        removedTranslationNode = hasRemovedTranslationNode(node) || removedTranslationNode;
        if (node instanceof Element && !isNextTranslateElement(node)) {
          hasNewContent = true;
        }
      }
    }

    if (hasNewContent || removedTranslationNode) {
      pendingNewContent = true;
      scheduleDomWork();
    }
  });

  mutationObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
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
