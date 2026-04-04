import type { ToggleTranslateResponse } from '@shared/messages';
import { loadProviderConfig } from '@shared/storage';
import { findMainContainer } from './extractor';
import { Translator } from './translator';
import { Injector } from './injector';
import { ProgressBar } from './progress';

// --- State ---

type TranslateState = 'idle' | 'translating' | 'done';

let state: TranslateState = 'idle';
let translationsVisible = true;
let toggleBusy = false;
let mutationObserver: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let mainContainer: Element | null = null;
let hasScrolledAfterTranslation = false;

const injector = new Injector();
const progressBar = new ProgressBar();

function scrollToFirstTranslation() {
  // Delay to let frameworks (React on X.com) finish re-rendering after DOM insertions
  setTimeout(() => {
    const container = mainContainer ?? document;
    const first = container.querySelector('.nt-translation');
    if (!first) return;

    // Find the nearest scrollable ancestor to scroll directly
    const scrollable = findScrollableAncestor(first);
    if (!scrollable) return;

    const rect = first.getBoundingClientRect();
    const viewportHeight = scrollable === document.documentElement
      ? window.innerHeight
      : scrollable.clientHeight;

    // Scroll to center the element in the viewport
    const offset = rect.top - viewportHeight / 2 + rect.height / 2;
    scrollable.scrollBy({ top: offset, behavior: 'smooth' });
  }, 100);
}

function findScrollableAncestor(el: Element): Element | null {
  let current = el.parentElement;
  while (current && current !== document.documentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  if (document.documentElement.scrollHeight > document.documentElement.clientHeight) {
    return document.documentElement;
  }
  return null;
}

const translator = new Translator({
  onBatchTranslated: (_, elements, translations) => {
    for (let i = 0; i < elements.length; i++) {
      injector.insertTranslation(elements[i], translations[i]);
    }
  },
  onProgress: (completed, total) => {
    progressBar.update(completed, total);
  },
  onComplete: () => {
    state = 'done';
    progressBar.complete();
    if (!hasScrolledAfterTranslation) {
      hasScrolledAfterTranslation = true;
      scrollToFirstTranslation();
    }
  },
  onError: (error) => {
    progressBar.error(error);
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
        if (translationsVisible) {
          scrollToFirstTranslation();
        }
        return { action: translationsVisible ? 'toggled_visible' : 'toggled_hidden' };
    }
  } finally {
    toggleBusy = false;
  }
}

// --- Translation flow ---

async function startTranslation() {
  state = 'translating';
  translationsVisible = true;
  hasScrolledAfterTranslation = false;

  const config = await loadProviderConfig();
  mainContainer = await findMainContainer();

  progressBar.show();
  await translator.start(mainContainer, config.targetLanguage);

  startObserver();
}

function cancelTranslation() {
  state = 'idle';
  translator.cancel();
  injector.hideAll();
  stopObserver();
}

// --- MutationObserver ---

function startObserver() {
  if (!mainContainer || mutationObserver) return;

  mutationObserver = new MutationObserver((mutations) => {
    let hasNewContent = false;
    let hasRemovedTranslation = false;

    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof Element && !node.className?.split?.(' ').some((c: string) => c.startsWith('nt-'))) {
          hasNewContent = true;
        }
      }
      for (const node of m.removedNodes) {
        if (node instanceof Element && node.classList?.contains('nt-translation')) {
          hasRemovedTranslation = true;
        }
      }
    }

    // Restore translations removed by framework re-renders
    if (hasRemovedTranslation) {
      injector.restoreRemovedTranslations();
    }

    // Incremental translation of new content
    if (hasNewContent) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (state !== 'done' && state !== 'translating') return;
        const config = await loadProviderConfig();
        await translator.start(mainContainer!, config.targetLanguage);
      }, 300);
    }
  });

  mutationObserver.observe(mainContainer, { childList: true, subtree: true });
}

function stopObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// --- SPA navigation ---

let currentUrl = location.href;

function handleSpaNavigation() {
  if (location.href === currentUrl) return;
  currentUrl = location.href;

  if (state === 'translating') {
    cancelTranslation();
  }

  state = 'idle';
  injector.removeAll();
  translator.resetState();
  stopObserver();
  mainContainer = null;
  hasScrolledAfterTranslation = false;
}

window.addEventListener('popstate', handleSpaNavigation);
window.addEventListener('hashchange', handleSpaNavigation);

const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function (...args) {
  originalPushState.apply(this, args);
  handleSpaNavigation();
};

history.replaceState = function (...args) {
  originalReplaceState.apply(this, args);
  handleSpaNavigation();
};

console.log('[NextTranslate] Content script injected');
