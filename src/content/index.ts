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

const injector = new Injector();
const progressBar = new ProgressBar();

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
    const firstTranslation = document.querySelector('.nt-translation');
    if (firstTranslation) {
      firstTranslation.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
