import {
  isProviderConfigured,
  loadActiveProviderId,
  loadProviderConfig,
  loadSiteTranslationSettings,
  saveProviderConfig,
  saveSiteTranslationSettings,
} from '@shared/storage';
import { ensureContentUiInjected } from '@shared/content-ui';
import { PROVIDER_PRESETS, type ProviderId } from '@shared/providers';
import { getSiteKeyFromUrl, isInjectablePageUrl } from '@shared/site';
import type { ProviderConfig } from '@shared/types';
import type { ToggleTranslateResponse, TranslateStatusMsg, TestConnectionResult } from '@shared/messages';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const translateBtn = $<HTMLButtonElement>('#translate-btn');
const saveBtn = $<HTMLButtonElement>('#save-btn');
const testBtn = $<HTMLButtonElement>('#test-btn');
const providerSelect = $<HTMLSelectElement>('#provider-preset');
const endpointLabel = $<HTMLLabelElement>('#endpoint-label');
const endpointInput = $<HTMLInputElement>('#endpoint');
const apiKeyInput = $<HTMLInputElement>('#api-key');
const modelInput = $<HTMLInputElement>('#model');
const targetLangSelect = $<HTMLSelectElement>('#target-language');
const configWarning = $<HTMLDivElement>('#config-warning');
const statusBar = $<HTMLDivElement>('#status-bar');
const testResult = $<HTMLDivElement>('#test-result');
const siteSettings = $<HTMLDivElement>('#site-settings');
const autoTranslateSiteInput = $<HTMLInputElement>('#auto-translate-site');
const autoTranslateSiteLabel = $<HTMLSpanElement>('#auto-translate-site-label');
const autoTranslateSiteHint = $<HTMLParagraphElement>('#auto-translate-site-hint');

interface ActiveSiteContext {
  url: string | null;
  siteKey: string | null;
  supported: boolean;
}

let currentConfig: ProviderConfig;
let latestLoadToken = 0;
let activeSiteContext: ActiveSiteContext = {
  url: null,
  siteKey: null,
  supported: false,
};

async function init() {
  const activeProvider = await loadActiveProviderId();
  providerSelect.value = activeProvider;
  await Promise.all([
    loadConfigIntoForm(activeProvider),
    loadActiveSiteContext(),
  ]);
  await queryCurrentStatus();
}

async function loadConfigIntoForm(providerId: ProviderId) {
  const loadToken = ++latestLoadToken;
  const config = await loadProviderConfig(providerId);
  if (loadToken !== latestLoadToken) {
    return;
  }

  currentConfig = config;
  endpointInput.value = currentConfig.endpoint;
  apiKeyInput.value = currentConfig.apiKey;
  modelInput.value = currentConfig.model;
  targetLangSelect.value = currentConfig.targetLanguage;
  updateEndpointVisibility(providerId);
  updateTranslateButton();
}

function updateEndpointVisibility(providerId: ProviderId) {
  endpointLabel.classList.toggle('hidden', providerId !== 'custom');
}

async function loadActiveSiteContext() {
  let url: string | null = null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tab?.url ?? null;
  } catch {
    url = null;
  }

  const siteKey = getSiteKeyFromUrl(url);
  const supported = isInjectablePageUrl(url) && siteKey !== null;

  activeSiteContext = {
    url,
    siteKey,
    supported,
  };

  siteSettings.classList.remove('hidden');

  if (!supported || !siteKey) {
    autoTranslateSiteInput.checked = false;
    autoTranslateSiteInput.disabled = true;
    autoTranslateSiteLabel.textContent = '总是翻译该网站';
    autoTranslateSiteHint.textContent = '当前页面不支持站点自动翻译设置';
    return;
  }

  const siteSettingsValue = await loadSiteTranslationSettings(siteKey);
  autoTranslateSiteInput.checked = siteSettingsValue.autoTranslate;
  autoTranslateSiteInput.disabled = false;
  autoTranslateSiteLabel.textContent = `总是翻译 ${siteKey}`;
  autoTranslateSiteHint.textContent = '保存后，该网站后续打开或刷新页面时会自动翻译。';
}

// Provider preset change
providerSelect.addEventListener('change', async () => {
  await loadConfigIntoForm(providerSelect.value as ProviderId);
});

function updateTranslateButton() {
  const configured = isProviderConfigured(currentConfig);
  translateBtn.disabled = !configured;
  configWarning.classList.toggle('hidden', configured);
}

// Save settings
saveBtn.addEventListener('click', async () => {
  const providerId = providerSelect.value as ProviderId;
  const preset = providerId === 'custom' ? undefined : PROVIDER_PRESETS[providerId];

  const newConfig: Partial<ProviderConfig> = {
    endpoint: preset ? preset.endpoint : endpointInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    targetLanguage: targetLangSelect.value,
  };

  // Validate endpoint URL format before saving
  if (newConfig.endpoint) {
    try {
      new URL(newConfig.endpoint);
    } catch {
      showTestResult('Endpoint URL 格式无效', 'error');
      return;
    }
  }

  await saveProviderConfig(newConfig, providerId);

  if (activeSiteContext.supported && activeSiteContext.siteKey) {
    await saveSiteTranslationSettings(activeSiteContext.siteKey, {
      autoTranslate: autoTranslateSiteInput.checked,
    });
  }

  await Promise.all([
    loadConfigIntoForm(providerId),
    loadActiveSiteContext(),
  ]);
  showTestResult('设置已保存', 'success');
});

// Test connection
testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testBtn.textContent = '测试中...';
  testResult.classList.remove('hidden');
  testResult.textContent = '正在连接...';
  testResult.className = 'testing';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }) as TestConnectionResult;
    if (result.success) {
      showTestResult('连接成功', 'success');
    } else {
      showTestResult(result.error ?? '连接失败', 'error');
    }
  } catch {
    showTestResult('无法连接到扩展后台', 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = '测试连接';
  }
});

// Translate button
translateBtn.addEventListener('click', async () => {
  translateBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    let response: ToggleTranslateResponse;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    } catch {
      const injected = await ensureContentUiInjected(tab.id, tab.url);
      if (!injected) return;
      response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    }

    updateUIFromResponse(response);
  } catch (e) {
    console.error('[NextTranslate] Toggle failed:', e);
  } finally {
    translateBtn.disabled = false;
  }
});

function updateUIFromResponse(response: ToggleTranslateResponse) {
  switch (response.action) {
    case 'started':
      translateBtn.textContent = '取消翻译';
      break;
    case 'cancelled':
      translateBtn.textContent = '翻译全文';
      break;
    case 'toggled_visible':
      translateBtn.textContent = '隐藏译文';
      break;
    case 'toggled_hidden':
      translateBtn.textContent = '显示译文';
      break;
    case 'busy':
      break;
  }
}

async function queryCurrentStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const status = await chrome.runtime.sendMessage({
      type: 'QUERY_STATUS',
      tabId: tab.id,
    }) as TranslateStatusMsg | null;

    if (status) {
      updateStatusUI(status);
    }
  } catch {
    // Background may not be ready
  }
}

chrome.runtime.onMessage.addListener((message: TranslateStatusMsg) => {
  if (message.type === 'TRANSLATE_STATUS') {
    updateStatusUI(message);
  }
});

function updateStatusUI(status: TranslateStatusMsg) {
  statusBar.classList.remove('hidden');

  switch (status.status) {
    case 'translating':
      if (status.progress?.total) {
        statusBar.textContent = `翻译中... ${status.progress.completed}/${status.progress.total}`;
      } else {
        statusBar.textContent = '翻译中...';
      }
      statusBar.className = 'translating';
      translateBtn.textContent = '取消翻译';
      break;
    case 'done':
      statusBar.textContent = '翻译完成';
      statusBar.className = 'done';
      translateBtn.textContent = '隐藏译文';
      setTimeout(() => statusBar.classList.add('hidden'), 3000);
      break;
    case 'cancelled':
      statusBar.textContent = '已取消';
      statusBar.className = 'cancelled';
      translateBtn.textContent = '翻译全文';
      setTimeout(() => statusBar.classList.add('hidden'), 2000);
      break;
    case 'error':
      statusBar.textContent = status.error ?? '翻译出错';
      statusBar.className = 'error';
      break;
  }
}

function showTestResult(message: string, type: 'success' | 'error') {
  testResult.classList.remove('hidden');
  testResult.textContent = message;
  testResult.className = type;
  if (type === 'success') {
    setTimeout(() => testResult.classList.add('hidden'), 3000);
  }
}

init();
