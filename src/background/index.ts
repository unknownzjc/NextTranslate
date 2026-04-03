import { loadProviderConfig, saveProviderConfig } from '@shared/storage';
import { buildTranslateRequest, parseJsonModeResponse, parseSeparatorModeResponse } from '@shared/prompt';
import type {
  TranslateBatchMsg,
  TranslateBatchResult,
  TranslateStatusMsg,
  QueryStatusMsg,
  TestConnectionResult,
} from '@shared/messages';

// --- Types ---

interface TabState {
  abortControllers: Map<string, AbortController>;
  completedBatches: number;
  totalBatches: number;
  status: 'translating' | 'done' | 'cancelled' | 'error';
  error?: string;
  retryBudget: number;
}

// --- State ---

const tabStates = new Map<number, TabState>();

// --- Request queue (global concurrency + round-robin) ---

const MAX_CONCURRENT = 3;
const REQUEST_INTERVAL_MS = 200;
let activeFetches = 0;

interface QueueItem {
  tabId: number;
  message: TranslateBatchMsg;
  sender: chrome.runtime.MessageSender;
  sendResponse: (result: TranslateBatchResult) => void;
}

const tabQueues = new Map<number, QueueItem[]>();
const activeTabIds: number[] = [];
let roundRobinIndex = 0;
let drainScheduled = false;

// Backoff state
let backoffUntil = 0;
let currentBackoffDelay = 2000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_MAX = 60000;

function enqueue(item: QueueItem) {
  const { tabId } = item;
  if (!tabQueues.has(tabId)) {
    tabQueues.set(tabId, []);
    activeTabIds.push(tabId);
  }
  tabQueues.get(tabId)!.push(item);
  scheduleDrain();
}

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;

  const now = Date.now();
  const delay = backoffUntil > now ? backoffUntil - now : 0;
  setTimeout(() => {
    drainScheduled = false;
    drain();
  }, delay);
}

function drain() {
  while (activeFetches < MAX_CONCURRENT && activeTabIds.length > 0) {
    if (roundRobinIndex >= activeTabIds.length) {
      roundRobinIndex = 0;
    }

    const tabId = activeTabIds[roundRobinIndex];
    const queue = tabQueues.get(tabId);

    if (!queue || queue.length === 0) {
      activeTabIds.splice(roundRobinIndex, 1);
      tabQueues.delete(tabId);
      continue;
    }

    const item = queue.shift()!;
    roundRobinIndex++;
    activeFetches++;

    processItem(item).finally(() => {
      activeFetches--;
      if (activeTabIds.length > 0) {
        setTimeout(scheduleDrain, REQUEST_INTERVAL_MS);
      }
    });
  }
}

async function processItem(item: QueueItem) {
  const { tabId, message, sendResponse } = item;
  const state = getOrCreateTabState(tabId);
  const controller = new AbortController();
  state.abortControllers.set(message.batchId, controller);

  // Start alarm keepalive on first batch
  if (state.completedBatches === 0 && state.totalBatches > 0) {
    startAlarmKeepalive();
  }

  try {
    const config = await loadProviderConfig();
    const mode = config.jsonMode === 'disabled' ? 'separator' as const : 'json' as const;

    const requestBody = buildTranslateRequest({
      texts: message.texts,
      targetLanguage: config.targetLanguage,
      model: config.model,
      mode,
    });

    const url = `${config.endpoint}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    // 429 backoff
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      const jitter = currentBackoffDelay * (0.8 + Math.random() * 0.4);
      const delay = retryAfter ?? jitter;
      currentBackoffDelay = Math.min(currentBackoffDelay * BACKOFF_MULTIPLIER, BACKOFF_MAX);
      backoffUntil = Date.now() + delay;

      chrome.storage.session?.set?.({
        'nt:backoffUntil': backoffUntil,
        'nt:backoffDelay': currentBackoffDelay,
      }).catch(() => {});

      enqueue(item);
      return;
    }

    // JSON mode auto-detect failure
    if ((response.status === 400 || response.status === 422) && config.jsonMode === 'auto' && mode === 'json') {
      await saveProviderConfig({ jsonMode: 'disabled' });
      enqueue(item);
      return;
    }

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content ?? '';

    if (config.jsonMode === 'auto' && mode === 'json') {
      const parsed = parseJsonModeResponse(rawContent, message.texts.length);
      if (parsed) {
        await saveProviderConfig({ jsonMode: 'enabled' });
        sendResponse({ batchId: message.batchId, translations: parsed.translations });
      } else {
        sendResponse({ batchId: message.batchId, translations: [], error: 'JSON parse failed' });
      }
    } else if (mode === 'json') {
      const parsed = parseJsonModeResponse(rawContent, message.texts.length);
      if (parsed) {
        sendResponse({ batchId: message.batchId, translations: parsed.translations });
      } else {
        sendResponse({ batchId: message.batchId, translations: [], error: 'JSON parse failed' });
      }
    } else {
      const parsed = parseSeparatorModeResponse(rawContent, message.texts.length);
      if (parsed) {
        sendResponse({ batchId: message.batchId, translations: parsed.translations });
      } else {
        sendResponse({ batchId: message.batchId, translations: [], error: 'Separator parse failed' });
      }
    }

    // Reset backoff on success
    currentBackoffDelay = 2000;

    // Update progress
    state.completedBatches++;
    broadcastProgress(tabId, state);

  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return;
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    // Retry budget
    if (state.retryBudget > 0) {
      state.retryBudget--;
      enqueue(item);
      return;
    }

    sendResponse({ batchId: message.batchId, translations: [], error: errorMsg });
  } finally {
    state.abortControllers.delete(message.batchId);
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// --- Tab state management ---

function getOrCreateTabState(tabId: number): TabState {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      abortControllers: new Map(),
      completedBatches: 0,
      totalBatches: 0,
      status: 'translating',
      retryBudget: 20,
    });
  }
  return tabStates.get(tabId)!;
}

function clearTabState(tabId: number) {
  const state = tabStates.get(tabId);
  if (state) {
    for (const controller of state.abortControllers.values()) {
      controller.abort();
    }
  }
  tabStates.delete(tabId);

  tabQueues.delete(tabId);
  const idx = activeTabIds.indexOf(tabId);
  if (idx !== -1) activeTabIds.splice(idx, 1);

  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});

  // Stop alarm if no more active tabs
  if (tabStates.size === 0) {
    stopAlarmKeepalive();
  }
}

function broadcastProgress(tabId: number, state: TabState) {
  const progress = { completed: state.completedBatches, total: state.totalBatches };
  const pct = state.totalBatches > 0 ? Math.round((state.completedBatches / state.totalBatches) * 100) : 0;

  chrome.action.setBadgeText({ text: `${pct}%`, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#4A90D9', tabId }).catch(() => {});

  const msg: TranslateStatusMsg = {
    type: 'TRANSLATE_STATUS',
    status: state.completedBatches >= state.totalBatches ? 'done' : 'translating',
    progress,
  };

  if (msg.status === 'done') {
    state.status = 'done';
    chrome.action.setBadgeText({ text: '\u2713', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
  }

  chrome.runtime.sendMessage(msg).catch(() => {});
}

// --- Alarm Keepalive ---

function startAlarmKeepalive() {
  chrome.alarms.create('nt-keepalive', { periodInMinutes: 1 });
}

function stopAlarmKeepalive() {
  chrome.alarms.clear('nt-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nt-keepalive') {
    console.log('[NextTranslate] Alarm keepalive tick');
  }
});

// --- Message routing ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'TRANSLATE_BATCH': {
      if (!tabId) return;
      const state = getOrCreateTabState(tabId);
      state.totalBatches = Math.max(state.totalBatches, message.totalBatches);
      enqueue({
        tabId,
        message: message as TranslateBatchMsg,
        sender,
        sendResponse: sendResponse as (result: TranslateBatchResult) => void,
      });
      return true;
    }

    case 'CANCEL_TRANSLATE': {
      if (!tabId) return;
      clearTabState(tabId);
      chrome.action.setBadgeText({ text: '\u2014', tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E', tabId }).catch(() => {});
      setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
      chrome.runtime.sendMessage({
        type: 'TRANSLATE_STATUS',
        status: 'cancelled',
      } satisfies TranslateStatusMsg).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    case 'QUERY_STATUS': {
      const queryMsg = message as QueryStatusMsg;
      const state = tabStates.get(queryMsg.tabId);
      if (state) {
        sendResponse({
          type: 'TRANSLATE_STATUS',
          status: state.status,
          progress: { completed: state.completedBatches, total: state.totalBatches },
          error: state.error,
        } satisfies TranslateStatusMsg);
      } else {
        sendResponse(null);
      }
      return;
    }

    case 'TEST_CONNECTION': {
      handleTestConnection().then(sendResponse);
      return true;
    }

    case 'KEEPALIVE': {
      sendResponse(true);
      return;
    }
  }
});

async function handleTestConnection(): Promise<TestConnectionResult> {
  try {
    const config = await loadProviderConfig();
    if (!config.endpoint || !config.apiKey || !config.model) {
      return { success: false, error: '请先完成配置' };
    }

    const requestBody = buildTranslateRequest({
      texts: ['hello'],
      targetLanguage: config.targetLanguage,
      model: config.model,
      mode: 'separator',
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) return { success: true };
    if (response.status === 401 || response.status === 403) return { success: false, error: 'API Key 无效' };
    if (response.status === 404) return { success: false, error: '端点地址错误' };
    return { success: false, error: `服务器返回错误: ${response.status}` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { success: false, error: '连接超时' };
    }
    return { success: false, error: '无法连接到服务器' };
  }
}

// --- Tab lifecycle ---

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearTabState(tabId);
  }
});

// --- Context menu ---

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'next-translate-page',
    title: '翻译此页面',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'next-translate-page' && tab?.id) {
    sendToggleToTab(tab.id);
  }
});

// --- Keyboard shortcut ---

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translate') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) sendToggleToTab(tab.id);
    });
  }
});

async function sendToggleToTab(tabId: number) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_TRANSLATE' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/index.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/style.css'] });
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_TRANSLATE' });
  }
}

// --- Backoff state recovery ---

(async () => {
  try {
    const data = await chrome.storage.session?.get?.(['nt:backoffUntil', 'nt:backoffDelay']);
    if (data?.['nt:backoffUntil']) {
      backoffUntil = data['nt:backoffUntil'] as number;
      currentBackoffDelay = (data['nt:backoffDelay'] as number | undefined) ?? 2000;
    }
  } catch { /* session storage may not be available */ }
})();

console.log('[NextTranslate] Background service worker started');
