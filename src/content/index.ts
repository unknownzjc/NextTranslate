import type {
  StartTranslateIfIdleMsg,
  StartTranslateIfIdleResponse,
  ToggleTranslateResponse,
  TranslateStatusMsg,
} from '@shared/messages';
import { CONTENT_SCRIPT_READY_KEY } from '@shared/content-ui';
import { isAutoTranslateEnabledForUrl, isProviderConfigured, loadProviderConfig } from '@shared/storage';
import { getMainDomain } from '@shared/site';
import type { ProviderConfig } from '@shared/types';
import {
  collectParagraphs,
  extractQuickTranslateParagraph,
  extractTextWithCodeProtection,
  findMainContainer,
  resolveHoverParagraphCandidate,
  type ExtractedParagraph,
} from './extractor';
import { Translator } from './translator';
import { Injector } from './injector';
import { ProgressBar } from './progress';
import { FloatingBall } from './floating-ball';
import { HoverController } from './hover-controller';

(window as unknown as Record<string, unknown>)[CONTENT_SCRIPT_READY_KEY] = true;

// --- State ---

type TranslateState = 'idle' | 'translating' | 'done';
type TranslateScope = 'none' | 'segment' | 'page';
type ActiveRunKind = 'none' | 'page' | 'segment' | 'retry';
type RetryStateSnapshot = {
  state: TranslateState;
  scope: TranslateScope;
  translationsVisible: boolean;
  progress: { completed: number; total: number };
};

const VIEWPORT_TRANSLATION_MARGIN_PX = 520;
const DOM_WORK_DEBOUNCE_MS = 180;
const SCROLL_IDLE_MS = 140;
const SPA_AUTO_TRANSLATE_DELAY_MS = 320;
const CONTENT_CLEANUP_KEY = '__NT_CONTENT_CLEANUP__';
const HISTORY_PATCH_KEY = '__NT_HISTORY_PATCH__';

type SpaNavigationOptions = { autoTranslateAfterNavigation?: boolean };
type HistoryPatchState = {
  originalPushState: History['pushState'];
  originalReplaceState: History['replaceState'];
  handleNavigation?: (nextUrl?: string, options?: SpaNavigationOptions) => void;
};
type ContentWindowState = typeof window & {
  [CONTENT_CLEANUP_KEY]?: () => void;
  [HISTORY_PATCH_KEY]?: HistoryPatchState;
};

const contentWindow = window as ContentWindowState;
contentWindow[CONTENT_CLEANUP_KEY]?.();
const eventAbortController = new AbortController();

let state: TranslateState = 'idle';
let scope: TranslateScope = 'none';
let translationsVisible = true;
let toggleBusy = false;
let mutationObserver: MutationObserver | null = null;
let domWorkTimer: ReturnType<typeof setTimeout> | null = null;
let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
let viewportQueueFrame: number | null = null;
let navigationAutoTranslateTimer: ReturnType<typeof setTimeout> | null = null;
let mainContainer: Element | null = null;
let pendingIncrementalTranslation = false;
let pendingNewContent = false;
let domWorkInProgress = false;
let isScrollActive = false;
let latestProgress = { completed: 0, total: 0 };
let activeRunKind: ActiveRunKind = 'none';
let activeRunHadBlockFailure = false;
let pageFailedElements = new Set<Element>();
let retryStateSnapshot: RetryStateSnapshot | null = null;
let retryTargetElement: Element | null = null;
let wasHistoryRestored = false;

const injector = new Injector();
const progressBar = new ProgressBar();
const useViewportLazyTranslation = getMainDomain(location.hostname) === 'x.com';
const floatingBall = new FloatingBall(() => {
  void handleFloatingBallClick();
});
let floatingBallErrorTimer: ReturnType<typeof setTimeout> | null = null;
injector.setRetryHandler((element) => {
  void handleFailedBlockRetry(element);
});


function clearFloatingBallErrorTimer() {
  if (!floatingBallErrorTimer) return;
  clearTimeout(floatingBallErrorTimer);
  floatingBallErrorTimer = null;
}

function syncFloatingBallState() {
  clearFloatingBallErrorTimer();

  if (state === 'translating') {
    if (scope === 'segment') {
      floatingBall.setState({ mode: 'idle' });
      return;
    }

    floatingBall.setState({ mode: 'translating' });
    return;
  }

  if (state === 'done') {
    if (scope === 'segment') {
      floatingBall.setState({ mode: 'idle' });
      return;
    }

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

function clearNavigationAutoTranslateTimer() {
  if (!navigationAutoTranslateTimer) return;
  clearTimeout(navigationAutoTranslateTimer);
  navigationAutoTranslateTimer = null;
}

async function handleFloatingBallClick() {
  const response = handleToggle();
  updateFloatingBallFromResponse(response);
}

function markPageTranslationDone() {
  state = 'done';
  scope = 'page';
  progressBar.complete();
  reportTranslateStatus('done', latestProgress, undefined, getRetriableFailedParagraphs().length);
  syncFloatingBallState();
}

function markSegmentTranslationDone() {
  state = 'done';
  scope = 'segment';
  progressBar.hide();
  syncFloatingBallState();
}

function hasRenderedTranslations(): boolean {
  return Array.from(document.querySelectorAll('.nt-translation[data-nt-id]'))
    .some((el) => !el.classList.contains('nt-loading') && (el.textContent ?? '').trim().length > 0);
}

function restoreIdleOrSegmentDone() {
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };

  if (hasRenderedTranslations()) {
    state = 'done';
    scope = 'segment';
  } else {
    state = 'idle';
    scope = 'none';
  }

  syncFloatingBallState();
}
function startRun(kind: Exclude<ActiveRunKind, 'none'>) {
  activeRunKind = kind;
  activeRunHadBlockFailure = false;
}

function clearActiveRun() {
  activeRunKind = 'none';
  activeRunHadBlockFailure = false;
  retryTargetElement = null;
}

function restoreRetryState() {
  const snapshot = retryStateSnapshot;
  retryStateSnapshot = null;
  clearActiveRun();
  if (!snapshot) return;

  state = snapshot.state;
  scope = snapshot.scope;
  translationsVisible = snapshot.translationsVisible;
  latestProgress = snapshot.progress;
  syncFloatingBallState();
}


function reportTranslateStatus(
  status: TranslateStatusMsg['status'],
  progress?: { completed: number; total: number },
  error?: string,
  failedCount?: number,
) {
  if (status === 'cancelled') return;

  try {
    chrome.runtime.sendMessage({
      type: 'REPORT_TRANSLATE_STATUS',
      status,
      progress,
      error,
      failedCount,
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
      pageFailedElements.delete(elements[i]);
    }
  },
  onProgress: (completed, total) => {
    if (activeRunKind === 'retry') {
      return;
    }

    latestProgress = { completed, total };

    if (activeRunKind === 'page') {
      progressBar.update(completed, total);
      reportTranslateStatus('translating', latestProgress);
    }

    syncFloatingBallState();
  },
  onBlocksQueued: (elements) => {
    for (const el of elements) {
      injector.showLoadingPlaceholder(el);
    }
  },
  onBlockFailed: (element, error) => {
    activeRunHadBlockFailure = true;

    if (activeRunKind === 'page') {
      pageFailedElements.add(element);
      if (element.isConnected) {
        injector.showRetryMarker(element);
      }
      return;
    }

    if (activeRunKind === 'retry') {
      const retryElement = retryTargetElement ?? element;
      if (retryElement.isConnected) {
        injector.showRetryMarker(retryElement);
      }
      restoreRetryState();
      return;
    }

    injector.clearLoadingIndicators();
    progressBar.hide();
    stopObserver();
    showFloatingBallError(error);
  },
  onComplete: () => {
    const runKind = activeRunKind;
    const hadBlockFailure = activeRunHadBlockFailure;

    if (runKind === 'retry') {
      restoreRetryState();
      return;
    }

    clearActiveRun();

    if (runKind === 'page') {
      if (pendingIncrementalTranslation && mainContainer) {
        pendingIncrementalTranslation = false;
        void startIncrementalTranslation().then(started => {
          if (!started) {
            markPageTranslationDone();
          }
        });
        return;
      }

      markPageTranslationDone();
      return;
    }

    if (runKind === 'segment') {
      stopObserver();
      if (hadBlockFailure) {
        restoreIdleOrSegmentDone();
        return;
      }
      markSegmentTranslationDone();
    }
  },
  onError: (error) => {
    const runKind = activeRunKind;

    if (runKind === 'retry') {
      const retryElement = retryTargetElement;
      if (retryElement?.isConnected) {
        injector.showRetryMarker(retryElement);
      }
      restoreRetryState();
      showFloatingBallError(error);
      return;
    }

    clearActiveRun();

    if (runKind === 'page') {
      state = 'idle';
      scope = 'none';
      pageFailedElements.clear();
      pendingIncrementalTranslation = false;
      pendingNewContent = false;
      injector.clearLoadingIndicators();
      progressBar.error(error);
      reportTranslateStatus('error', latestProgress, error);
      stopObserver();
      showFloatingBallError(error);
      return;
    }

    // segment error: silent local recovery
    injector.clearLoadingIndicators();
    progressBar.hide();
    stopObserver();
    showFloatingBallError(error);
    restoreIdleOrSegmentDone();
  },
  onCancelled: () => {
    const runKind = activeRunKind;

    if (runKind === 'retry') {
      const retryElement = retryTargetElement;
      if (retryElement?.isConnected) {
        injector.showRetryMarker(retryElement);
      }
      restoreRetryState();
      return;
    }

    clearActiveRun();

    if (runKind === 'page') {
      state = 'idle';
      scope = 'none';
      pageFailedElements.clear();
      pendingIncrementalTranslation = false;
      pendingNewContent = false;
      injector.clearLoadingIndicators();
      progressBar.hide();
      syncFloatingBallState();
      return;
    }

    // segment cancel: preserve existing translations
    injector.clearLoadingIndicators();
    progressBar.hide();
    stopObserver();
    restoreIdleOrSegmentDone();
  },
});

// --- Message listener ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TOGGLE_TRANSLATE') {
    const response = handleToggle();
    sendResponse(response);
    return;
  }

  if (message.type === 'START_TRANSLATE_IF_IDLE') {
    sendResponse(handleStartTranslateIfIdle(message));
  }
});

function handleToggle(): ToggleTranslateResponse {
  if (toggleBusy || activeRunKind === 'retry') return { action: 'busy' };

  toggleBusy = true;
  try {
    switch (state) {
      case 'idle':
        startTranslationIfIdle();
        return { action: 'started' };

      case 'translating':
        cancelTranslation();
        return { action: 'cancelled' };

      case 'done':
        if (scope === 'segment') {
          void startTranslation();
          return { action: 'started' };
        }

        if (scope === 'page') {
          const failedParagraphs = getRetriableFailedParagraphs();
          if (failedParagraphs.length > 0) {
            void resumeFailedPageTranslation(failedParagraphs);
            return { action: 'started' };
          }
        }

        translationsVisible = !translationsVisible;
        injector.setVisibility(translationsVisible);
        syncFloatingBallState();
        return { action: translationsVisible ? 'toggled_visible' : 'toggled_hidden' };
    }
  } finally {
    toggleBusy = false;
  }
}

function getNavigationType(): PerformanceNavigationTiming['type'] | null {
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  return entry?.type ?? null;
}

function isHistoryTraversalRestore(): boolean {
  return getNavigationType() === 'back_forward' || wasHistoryRestored;
}

function handleStartTranslateIfIdle(message: StartTranslateIfIdleMsg): StartTranslateIfIdleResponse {
  if (message.reason === 'auto' && isHistoryTraversalRestore()) {
    return { started: false };
  }

  if (toggleBusy) {
    return { started: false };
  }

  return { started: startTranslationIfIdle() };
}

function startTranslationIfIdle(): boolean {
  if (state !== 'idle') {
    return false;
  }

  void startTranslation();
  return true;
}

async function maybeAutoTranslateCurrentPage() {
  if (toggleBusy || state !== 'idle') {
    return false;
  }

  const autoTranslateEnabled = await isAutoTranslateEnabledForUrl(location.href);
  if (!autoTranslateEnabled) {
    return false;
  }

  return startTranslationIfIdle();
}

function scheduleAutoTranslateAfterSpaNavigation() {
  clearNavigationAutoTranslateTimer();
  navigationAutoTranslateTimer = setTimeout(() => {
    navigationAutoTranslateTimer = null;
    void maybeAutoTranslateCurrentPage();
  }, SPA_AUTO_TRANSLATE_DELAY_MS);
}

// --- Translation flow ---

function getTranslationIncludeElement(): ((el: Element) => boolean) | undefined {
  if (!useViewportLazyTranslation) return undefined;
  return (el: Element) => isNearViewport(el, VIEWPORT_TRANSLATION_MARGIN_PX);
}

function getCurrentSourceText(el: Element): string {
  return extractTextWithCodeProtection(el).text.trim();
}

function hasFreshRenderedTranslation(el: Element): boolean {
  if (!injector.hasTranslation(el)) return false;
  const text = getCurrentSourceText(el);
  if (!text) return false;
  return translator.hasUpToDateTranslation(el, text);
}

function hasFreshFailedTranslation(el: Element): boolean {
  const text = getCurrentSourceText(el);
  if (!text) return false;
  return translator.hasUpToDateFailure(el, text);
}

function shouldSkipRenderedElement(el: Element): boolean {
  return hasFreshRenderedTranslation(el) || hasFreshFailedTranslation(el);
}

function getRetriableFailedParagraphs(): ExtractedParagraph[] {
  const paragraphs: ExtractedParagraph[] = [];

  for (const element of Array.from(pageFailedElements)) {
    if (!element.isConnected) {
      pageFailedElements.delete(element);
      continue;
    }

    const { text, codeMap } = extractTextWithCodeProtection(element);
    const sourceText = text.trim();
    if (!sourceText) {
      pageFailedElements.delete(element);
      injector.clearRetryMarker(element);
      continue;
    }

    if (!translator.hasUpToDateFailure(element, sourceText)) {
      pageFailedElements.delete(element);
      continue;
    }

    paragraphs.push({ element, text: sourceText, codeMap });
  }

  return paragraphs;
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

  if (scope === 'page' && state !== 'idle' && !mutationObserver) {
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
  startRun('page');
  await translator.start(mainContainer, currentConfig.targetLanguage, options);
  return true;
}

async function startTranslation() {
  clearNavigationAutoTranslateTimer();
  pageFailedElements.clear();
  state = 'translating';
  scope = 'page';
  translationsVisible = true;
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  injector.setVisibility(true);
  injector.setScope('page');
  syncFloatingBallState();

  const config = await loadProviderConfig();
  if (!isProviderConfigured(config)) {
    state = 'idle';
    scope = 'none';
    const error = '请先在扩展弹窗中完成翻译配置';
    progressBar.show();
    progressBar.error(error);
    reportTranslateStatus('error', latestProgress, error);
    showFloatingBallError(error);
    return;
  }

  const started = await runTranslationPass(config);
  if (!started) {
    markPageTranslationDone();
  }

  startObserver();
}

async function resumeFailedPageTranslation(failedParagraphs = getRetriableFailedParagraphs()) {
  clearNavigationAutoTranslateTimer();

  if (failedParagraphs.length === 0) {
    markPageTranslationDone();
    return false;
  }

  const ready = await ensureMainContainerReady();
  if (!ready || !mainContainer) return false;

  const config = await loadProviderConfig();
  if (!isProviderConfigured(config)) {
    const error = '请先在扩展弹窗中完成翻译配置';
    progressBar.show();
    progressBar.error(error);
    reportTranslateStatus('error', latestProgress, error, failedParagraphs.length);
    showFloatingBallError(error);
    return false;
  }

  translationsVisible = true;
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  state = 'translating';
  scope = 'page';
  injector.setVisibility(true);
  injector.setTargetLanguage(config.targetLanguage);
  injector.setScope('page');
  progressBar.show();
  syncFloatingBallState();
  startRun('page');

  await translator.start(mainContainer, config.targetLanguage, {
    paragraphs: failedParagraphs,
    shouldSkipElement: shouldSkipRenderedElement,
    retryFailed: true,
  });
  startObserver();
  return true;
}

function isEditableElement(el: Element | null): boolean {
  return el?.matches('input, textarea, select, [contenteditable], [contenteditable="true"]') ?? false;
}

function isEditableFocusActive(): boolean {
  const active = document.activeElement;
  if (!(active instanceof Element)) return false;
  return isEditableElement(active) || active.closest('input, textarea, select, [contenteditable], [contenteditable="true"]') !== null;
}

function isTranslationInProgress(): boolean {
  return state === 'translating' || activeRunKind === 'retry';
}

async function handleSegmentTranslation(element: Element): Promise<boolean> {
  if (isTranslationInProgress()) return false;
  if (scope === 'page') return false;
  if (!element.isConnected) return false;
  if (isEditableFocusActive()) return false;
  if (hasFreshRenderedTranslation(element)) return false;

  clearNavigationAutoTranslateTimer();

  const config = await loadProviderConfig();
  if (!isProviderConfigured(config)) {
    showFloatingBallError('请先在扩展弹窗中完成翻译配置');
    return false;
  }

  const paragraph = extractQuickTranslateParagraph(element);
  if (!paragraph) {
    return false;
  }

  if (isTranslationInProgress()) return false;

  translationsVisible = true;
  injector.setVisibility(true);
  injector.setTargetLanguage(config.targetLanguage);
  injector.detectTheme(element);
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  state = 'translating';
  scope = 'segment';
  progressBar.hide();
  injector.setScope('segment');
  syncFloatingBallState();
  startRun('segment');

  await translator.start(element, config.targetLanguage, {
    paragraphs: [paragraph],
    shouldSkipElement: shouldSkipRenderedElement,
  });
  return true;
}

async function handleFailedBlockRetry(element: Element): Promise<boolean> {
  if (isTranslationInProgress()) return false;
  if (state !== 'done' || scope !== 'page') return false;
  if (!element.isConnected) {
    injector.clearRetryMarker(element);
    return false;
  }

  clearNavigationAutoTranslateTimer();

  const config = await loadProviderConfig();
  if (!isProviderConfigured(config)) {
    showFloatingBallError('请先在扩展弹窗中完成翻译配置');
    return false;
  }

  const { text, codeMap } = extractTextWithCodeProtection(element);
  const sourceText = text.trim();
  if (!sourceText) {
    injector.clearRetryMarker(element);
    return false;
  }

  retryStateSnapshot = {
    state,
    scope,
    translationsVisible,
    progress: latestProgress,
  };
  retryTargetElement = element;
  injector.setTargetLanguage(config.targetLanguage);
  injector.detectTheme(element);
  injector.setScope('page');
  startRun('retry');

  await translator.start(element, config.targetLanguage, {
    paragraphs: [{ element, text: sourceText, codeMap }],
    shouldSkipElement: shouldSkipRenderedElement,
    retryFailed: true,
  });
  return true;
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
  if (scope !== 'page') return;
  if (activeRunKind === 'retry') return;
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
  clearNavigationAutoTranslateTimer();
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };

  if (scope === 'segment') {
    translator.cancel();
    injector.clearLoadingIndicators();
    progressBar.hide();
    stopObserver();
    restoreIdleOrSegmentDone();
    return;
  }

  state = 'idle';
  scope = 'none';
  pageFailedElements.clear();
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
  if (scope !== 'page') return;
  if (domWorkInProgress || isScrollActive || activeRunKind === 'retry') return;

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
  if (scope === 'page' && mainContainer && !mainContainer.isConnected) {
    pendingNewContent = true;
    scheduleDomWork(0);
  }

  if (scope === 'page' && useViewportLazyTranslation && (state === 'translating' || state === 'done')) {
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

window.addEventListener('scroll', handleScroll, { passive: true, signal: eventAbortController.signal });

function handlePageShow(event: PageTransitionEvent) {
  if (event.persisted) {
    wasHistoryRestored = true;
  }
}

window.addEventListener('pageshow', handlePageShow, { signal: eventAbortController.signal });

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
  clearNavigationAutoTranslateTimer();
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

function handleSpaNavigation(nextUrl?: string, options: SpaNavigationOptions = {}) {
  const nextNavigationKey = getNavigationKey(nextUrl);
  if (nextNavigationKey === currentNavigationKey) return;
  currentNavigationKey = nextNavigationKey;

  if (state === 'translating') {
    cancelTranslation();
  }

  retryStateSnapshot = null;
  clearActiveRun();
  state = 'idle';
  scope = 'none';
  pendingIncrementalTranslation = false;
  pendingNewContent = false;
  latestProgress = { completed: 0, total: 0 };
  pageFailedElements.clear();
  injector.removeAll();
  translator.resetState();
  stopObserver();
  mainContainer = null;
  hoverController.reset();
  syncFloatingBallState();
  if (options.autoTranslateAfterNavigation) {
    scheduleAutoTranslateAfterSpaNavigation();
  }
}

function handlePopState() {
  handleSpaNavigation();
}

window.addEventListener('popstate', handlePopState, { signal: eventAbortController.signal });

function getHistoryStateUrlArg(args: Parameters<History['pushState']>): string | undefined {
  return typeof args[2] === 'string' || args[2] instanceof URL ? String(args[2]) : undefined;
}

function installHistoryPatch() {
  if (!contentWindow[HISTORY_PATCH_KEY]) {
    const patchState: HistoryPatchState = {
      originalPushState: history.pushState,
      originalReplaceState: history.replaceState,
    };
    contentWindow[HISTORY_PATCH_KEY] = patchState;

    history.pushState = function (...args) {
      patchState.originalPushState.apply(this, args);
      patchState.handleNavigation?.(getHistoryStateUrlArg(args), { autoTranslateAfterNavigation: true });
    };

    history.replaceState = function (...args) {
      patchState.originalReplaceState.apply(this, args);
      patchState.handleNavigation?.(getHistoryStateUrlArg(args), { autoTranslateAfterNavigation: true });
    };
  }

  contentWindow[HISTORY_PATCH_KEY].handleNavigation = handleSpaNavigation;
}

installHistoryPatch();

const hoverController = new HoverController({
  onTrigger: (el) => handleSegmentTranslation(el),
  resolveCandidate: resolveHoverParagraphCandidate,
  isTranslatable: (el) => !hasFreshRenderedTranslation(el),
});
hoverController.enable();

contentWindow[CONTENT_CLEANUP_KEY] = () => {
  eventAbortController.abort();
  clearNavigationAutoTranslateTimer();
  translator.cancel();
  stopObserver();
  hoverController.destroy();
  clearFloatingBallErrorTimer();
};

console.log('[NextTranslate] Content script injected');
