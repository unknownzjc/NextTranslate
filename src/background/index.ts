import { isAutoTranslateEnabledForUrl, loadProviderConfig, saveProviderConfig } from '@shared/storage';
import { buildTranslateRequest, parseJsonModeResponse, parseSeparatorModeResponse } from '@shared/prompt';
import { ensureContentUiInjected } from '@shared/content-ui';
import type {
  TranslateBatchMsg,
  TranslateBatchResult,
  TranslateStatusMsg,
  QueryStatusMsg,
  ReportTranslateStatusMsg,
  TestConnectionResult,
} from '@shared/messages';

// --- Types ---

interface PendingRequest {
  controller: AbortController;
  sendResponse: (result: TranslateBatchResult) => void;
}

interface TabState {
  pendingRequests: Map<string, PendingRequest>;
  completedBatches: number;
  totalBatches: number;
  status: 'translating' | 'done' | 'cancelled' | 'error';
  error?: string;
  failedCount?: number;
  retryBudget: number;
}

// --- State ---

const tabStates = new Map<number, TabState>();
const historyTraversalTabs = new Set<number>();

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

function createCancelledBatchResult(batchId: string): TranslateBatchResult {
  return {
    batchId,
    translations: [],
    cancelled: true,
  };
}

async function processItem(item: QueueItem) {
  const { tabId, message, sendResponse } = item;
  const state = getOrCreateTabState(tabId);
  const controller = new AbortController();
  state.pendingRequests.set(message.batchId, { controller, sendResponse });
  state.status = 'translating';
  syncAlarmKeepalive();

  try {
    const config = await loadProviderConfig();
    const mode = config.jsonMode === 'disabled' ? 'separator' as const : 'json' as const;

    const requestBody = buildTranslateRequest({
      texts: message.texts,
      targetLanguage: config.targetLanguage,
      model: config.model,
      mode,
      purpose: message.purpose,
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
        await saveProviderConfig({ jsonMode: 'disabled' });
        enqueue(item);
        return;
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

    currentBackoffDelay = 2000;

  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      const pending = state.pendingRequests.get(message.batchId);
      if (pending) {
        pending.sendResponse(createCancelledBatchResult(message.batchId));
        state.pendingRequests.delete(message.batchId);
      }
      return;
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    if (state.retryBudget > 0) {
      state.retryBudget--;
      enqueue(item);
      return;
    }

    sendResponse({ batchId: message.batchId, translations: [], error: errorMsg });
  } finally {
    state.pendingRequests.delete(message.batchId);
    syncAlarmKeepalive();
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
      pendingRequests: new Map(),
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
    for (const [batchId, pending] of state.pendingRequests) {
      pending.controller.abort();
      pending.sendResponse(createCancelledBatchResult(batchId));
    }
    state.pendingRequests.clear();
  }
  tabStates.delete(tabId);

  const queuedItems = tabQueues.get(tabId) ?? [];
  for (const item of queuedItems) {
    item.sendResponse(createCancelledBatchResult(item.message.batchId));
  }
  tabQueues.delete(tabId);
  const idx = activeTabIds.indexOf(tabId);
  if (idx !== -1) activeTabIds.splice(idx, 1);

  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  syncAlarmKeepalive();
}

function publishTabStatus(tabId: number, state: TabState) {
  const progress = state.totalBatches > 0
    ? { completed: state.completedBatches, total: state.totalBatches }
    : undefined;
  const pct = progress ? Math.round((progress.completed / progress.total) * 100) : 0;

  switch (state.status) {
    case 'translating':
      chrome.action.setBadgeText({ text: progress ? `${pct}%` : '', tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#4A90D9', tabId }).catch(() => {});
      break;
    case 'done':
      chrome.action.setBadgeText({ text: '\u2713', tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId }).catch(() => {});
      setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
      break;
    case 'error':
      chrome.action.setBadgeText({ text: '!', tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#F44336', tabId }).catch(() => {});
      break;
    case 'cancelled':
      chrome.action.setBadgeText({ text: '\u2014', tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E', tabId }).catch(() => {});
      setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
      break;
  }

  chrome.runtime.sendMessage({
    type: 'TRANSLATE_STATUS',
    status: state.status,
    progress,
    error: state.error,
    failedCount: state.failedCount,
  } satisfies TranslateStatusMsg).catch(() => {});

  syncAlarmKeepalive();
}

// --- Alarm Keepalive ---

function hasActiveTranslations(): boolean {
  return Array.from(tabStates.values()).some((state) =>
    state.status === 'translating' || state.pendingRequests.size > 0
  );
}

function syncAlarmKeepalive() {
  if (hasActiveTranslations()) {
    startAlarmKeepalive();
  } else {
    stopAlarmKeepalive();
  }
}

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
      state.status = 'translating';
      state.error = undefined;
      enqueue({
        tabId,
        message: message as TranslateBatchMsg,
        sender,
        sendResponse: sendResponse as (result: TranslateBatchResult) => void,
      });
      return true;
    }

    case 'REPORT_TRANSLATE_STATUS': {
      if (!tabId) return;
      const report = message as ReportTranslateStatusMsg;
      const state = getOrCreateTabState(tabId);
      state.status = report.status;
      state.error = report.error;
      state.completedBatches = report.progress?.completed ?? state.completedBatches;
      state.totalBatches = report.progress?.total ?? state.totalBatches;
      state.failedCount = report.failedCount ?? (report.status === 'translating' ? undefined : state.failedCount);
      publishTabStatus(tabId, state);
      sendResponse({ ok: true });
      return;
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
          failedCount: state.failedCount,
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

    try {
      const response = await fetch(`${config.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (response.ok) return { success: true };

      const detail = await readErrorDetail(response);
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: detail ? `API Key 无效\n${detail}` : 'API Key 无效' };
      }
      if (response.status === 404) {
        return { success: false, error: detail ? `端点地址错误\n${detail}` : '端点地址错误' };
      }
      return {
        success: false,
        error: detail
          ? `服务器返回错误: ${response.status}\n${detail}`
          : `服务器返回错误: ${response.status}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { success: false, error: '连接超时' };
    }
    return {
      success: false,
      error: '无法连接到服务器，请检查网络、接口地址，或确认目标服务允许浏览器扩展访问（必要时使用代理）',
    };
  }
}

async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const data = await response.json() as {
        error?: { message?: unknown; type?: unknown; code?: unknown };
        message?: unknown;
        detail?: unknown;
      };

      const message = [
        typeof data.error?.message === 'string' ? data.error.message : null,
        typeof data.message === 'string' ? data.message : null,
        typeof data.detail === 'string' ? data.detail : null,
      ].find((value): value is string => Boolean(value?.trim()));

      const meta = [
        typeof data.error?.type === 'string' ? `type: ${data.error.type}` : null,
        typeof data.error?.code === 'string' || typeof data.error?.code === 'number'
          ? `code: ${String(data.error.code)}`
          : null,
      ].filter((value): value is string => Boolean(value));

      if (message && meta.length > 0) return `${message}\n${meta.join('\n')}`;
      if (message) return message;

      const fallback = JSON.stringify(data);
      return fallback === '{}' ? null : fallback;
    }

    const text = (await response.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}

// --- Content UI injection ---

async function injectOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => tab.id ? ensureContentUiInjected(tab.id, tab.url) : Promise.resolve(false)));
}

// --- Tab lifecycle ---

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
  historyTraversalTabs.delete(tabId);
});

chrome.webNavigation?.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;

  if (details.transitionQualifiers.includes('forward_back')) {
    historyTraversalTabs.add(details.tabId);
    return;
  }

  historyTraversalTabs.delete(details.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    clearTabState(tabId);
    return;
  }

  if (changeInfo.status === 'complete') {
    void ensureContentUiInjected(tabId, tab.url)
      .then(() => maybeAutoTranslateTab(tabId, tab.url));
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then(tab => ensureContentUiInjected(tabId, tab.url))
    .catch(() => false);
});

chrome.runtime.onStartup.addListener(() => {
  void injectOpenTabs();
});

// --- Context menu ---

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'next-translate-page',
    title: '翻译此页面',
    contexts: ['page'],
  });

  void injectOpenTabs();
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
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const injected = await ensureContentUiInjected(tabId, tab?.url);
    if (!injected) return;
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_TRANSLATE' });
  }
}

async function sendStartTranslateIfIdleToTab(tabId: number, url?: string | null) {
  const injected = await ensureContentUiInjected(tabId, url);
  if (!injected) return;

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'START_TRANSLATE_IF_IDLE', reason: 'auto' });
  } catch {
    // Ignore tabs that navigated away or no longer accept messages.
  }
}

async function maybeAutoTranslateTab(tabId: number, url?: string | null) {
  if (historyTraversalTabs.has(tabId)) {
    historyTraversalTabs.delete(tabId);
    return;
  }

  if (!await isAutoTranslateEnabledForUrl(url)) {
    return;
  }

  await sendStartTranslateIfIdleToTab(tabId, url);
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
