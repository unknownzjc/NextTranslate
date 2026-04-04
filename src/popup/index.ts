import { loadProviderConfig, saveProviderConfig, isProviderConfigured } from '@shared/storage';
import type { ProviderConfig } from '@shared/types';
import type { ToggleTranslateResponse, TranslateStatusMsg, TestConnectionResult } from '@shared/messages';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

interface ProviderPreset {
  endpoint: string;
  model: string;
}

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  kimi: { endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
};

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

let currentConfig: ProviderConfig;

async function init() {
  currentConfig = await loadProviderConfig();
  endpointInput.value = currentConfig.endpoint;
  apiKeyInput.value = currentConfig.apiKey;
  modelInput.value = currentConfig.model;
  targetLangSelect.value = currentConfig.targetLanguage;

  // Detect which provider preset matches the current endpoint
  const detectedProvider = detectProvider(currentConfig.endpoint);
  providerSelect.value = detectedProvider;
  updateEndpointVisibility(detectedProvider);

  updateTranslateButton();

  await queryCurrentStatus();
}

function detectProvider(endpoint: string): string {
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (endpoint === preset.endpoint) return key;
  }
  return endpoint ? 'custom' : 'openai';
}

function updateEndpointVisibility(provider: string) {
  endpointLabel.classList.toggle('hidden', provider !== 'custom');
}

// Provider preset change
providerSelect.addEventListener('change', () => {
  const provider = providerSelect.value;
  const preset = PROVIDER_PRESETS[provider];

  if (preset) {
    endpointInput.value = preset.endpoint;
    modelInput.value = preset.model;
  } else {
    endpointInput.value = '';
    modelInput.value = '';
  }

  updateEndpointVisibility(provider);
});

function updateTranslateButton() {
  const configured = isProviderConfigured(currentConfig);
  translateBtn.disabled = !configured;
  configWarning.classList.toggle('hidden', configured);
}

// Save settings
saveBtn.addEventListener('click', async () => {
  const provider = providerSelect.value;
  const preset = PROVIDER_PRESETS[provider];

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

  await saveProviderConfig(newConfig);
  currentConfig = await loadProviderConfig();
  updateTranslateButton();
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
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/index.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/style.css'],
      });
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
