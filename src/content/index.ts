import type { ToggleTranslateResponse, TranslateStatusMsg } from '@shared/messages';
import { CONTENT_SCRIPT_READY_KEY } from '@shared/content-ui';
import { isProviderConfigured, loadProviderConfig } from '@shared/storage';
import type { ProviderConfig } from '@shared/types';
import { collectParagraphs, findMainContainer } from './extractor';
import { getMainDomain } from './compat';
import { Translator } from './translator';
import { Injector } from './injector';
import { ProgressBar } from './progress';
import { FloatingBall } from './floating-ball';

(window as unknown as Record<string, unknown>)[CONTENT_SCRIPT_READY_KEY] = true;

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
let viewportQueueFrame: number | null = null;
let mainContainer: Element | null = null;
let pendingIncrementalTranslation = false;
let pendingNewContent = false;
let domWorkInProgress = false;
let isScrollActive = false;
let latestProgress = { completed: 0, total: 0 };

const injector = new Injector();
const progressBar = new ProgressBar();
const useViewportLazyTranslation = getMainDomain(location.hostname) === 'x.com';
const floatingBall = new FloatingBall(() => {
  void handleFloatingBallClick();
});
let floatingBallErrorTimer: ReturnType<typeof setTimeout> | null = null;

function clearFloatingBallErrorTimer() {
  if (!floatingBallErrorTimer) return;
  clearTimeout(floatingBallErrorTimer);
  floatingBallErrorTimer = null;
}

function syncFloatingBallState() {
  clearFloatingBallErrorTimer();

  if (state === 'translating') {
    floatingBall.setState({ mode: 'translating' });
    return;
  }

  if (state === 'done') {
    floatingBall.setState({ mode: 'translated', visible: translationsVisible });
    return;
  }

  floatingBall.setState({ mode: 'idle' });
}

function showFloatingBallError(message: string) {
  clearFloatingBallErrorTimer();
  floatingBall.setState({ mode: 'error', message });
  floatingBallErrorTimer = setTimeout(() => {
    floatingBallErrorTimer = null;
    syncFloatingBallState();
  }, 2800);
}

function updateFloatingBallFromResponse(response: ToggleTranslateResponse) {
  if (response.action === 'busy') return;
  syncFloatingBallState();
}

async function handleFloatingBallClick() {
  const response = handleToggle();
  updateFloatingBallFromResponse(response);
}

function markTranslationDone() {
  state = 'done';
  progressBar.complete();
  reportTranslateStatus('done', latestProgress);
  syncFloatingBallState();
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
    syncFloatingBallState();
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
    state = 'idle';
    pendingIncrementalTranslation = false;
    pendingNewContent = false;
    injector.clearLoadingIndicators();
    progressBar.error(error);
    reportTranslateStatus('error', latestProgress, error);
    stopObserver();
    showFloatingBallError(error);
  },
  onCancelled: () => {
    state = 'idle';
    pendingIncrementalTranslation = false;
    pendingNewContent = false;
    injector.clearLoadingIndicators();
    progressBar.hide();
    syncFloatingBallState();
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
        void startTranslation();
        return { action: 'started' };

      case 'translating':
        cancelTranslation();
        return { action: 'cancelled' };

      case 'done':
        translationsVisible = !translationsVisible;
        injector.setVisibility(translationsVisible);
        syncFloatingBallState();
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

async function runTranslationPass(config?: ProviderConfig) {
  const ready = await ensureMainContainerReady();
  if (!ready || !mainContainer) return false;

  const currentConfig = config ?? await loadProviderConfig();
  injector.setTargetLanguage(currentConfig.targetLanguage);

  const includeElement = getTranslationIncludeElement();
  const options = { includeElement, shouldSkipElement: shouldSkipRenderedElement };
  if (!translator.hasPendingWork(mainContainer, options)) {
    return false;
  }

  state = 'translating';
  latestProgress = { completed: 0, total: 0 };
  progressBar.show();
  syncFloatingBallState();
  await translator.start(mainContainer, currentConfig.targetLanguage, options);
  return true;
}

async function startTranslation() {
  state = 'translating';
  translationsVisible = true;
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  injector.setVisibility(true);
  syncFloatingBallState();

  const config = await loadProviderConfig();
  if (!isProviderConfigured(config)) {
    state = 'idle';
    const error = '请先在扩展弹窗中完成翻译配置';
    progressBar.show();
    progressBar.error(error);
    reportTranslateStatus('error', latestProgress, error);
    showFloatingBallError(error);
    return;
  }

  const started = await runTranslationPass(config);
  if (!started) {
    markTranslationDone();
  }

  startObserver();
}

async function startIncrementalTranslation() {
  pendingNewContent = false;
  return runTranslationPass();
}

function scheduleViewportQueuePreview() {
  if (!useViewportLazyTranslation || viewportQueueFrame !== null) return;

  viewportQueueFrame = window.requestAnimationFrame(() => {
    viewportQueueFrame = null;
    void primeViewportQueuePreview();
  });
}

async function primeViewportQueuePreview() {
  if (!useViewportLazyTranslation || (state !== 'translating' && state !== 'done')) return;

  const ready = await ensureMainContainerReady();
  if (!ready || !mainContainer) return;

  const includeElement = getTranslationIncludeElement();
  if (!includeElement) return;

  const pendingViewportParagraphs = collectParagraphs(
    mainContainer,
    (el) => shouldSkipRenderedElement(el),
    includeElement,
  );

  if (pendingViewportParagraphs.length === 0) return;

  for (const { element } of pendingViewportParagraphs) {
    injector.showLoadingPlaceholder(element);
  }

  if (state === 'translating') {
    pendingIncrementalTranslation = true;
  }
}

function cancelTranslation() {
  state = 'idle';
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  translator.cancel();
  injector.hideAll();
  stopObserver();
  syncFloatingBallState();
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

  if (useViewportLazyTranslation && (state === 'translating' || state === 'done')) {
    scheduleViewportQueuePreview();
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
  if (viewportQueueFrame !== null) {
    cancelAnimationFrame(viewportQueueFrame);
    viewportQueueFrame = null;
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
  syncFloatingBallState();
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
