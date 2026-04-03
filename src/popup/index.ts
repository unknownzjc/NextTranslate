import { loadProviderConfig, saveProviderConfig, requestEndpointPermission, removeEndpointPermission, isProviderConfigured } from '@shared/storage';
import type { ProviderConfig } from '@shared/types';
import type { ToggleTranslateResponse, TranslateStatusMsg, TestConnectionResult } from '@shared/messages';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const translateBtn = $<HTMLButtonElement>('#translate-btn');
const saveBtn = $<HTMLButtonElement>('#save-btn');
const testBtn = $<HTMLButtonElement>('#test-btn');
const endpointInput = $<HTMLInputElement>('#endpoint');
const apiKeyInput = $<HTMLInputElement>('#api-key');
const modelInput = $<HTMLInputElement>('#model');
const targetLangSelect = $<HTMLSelectElement>('#target-language');
const configWarning = $<HTMLDivElement>('#config-warning');
const statusBar = $<HTMLDivElement>('#status-bar');
const testResult = $<HTMLDivElement>('#test-result');

let currentConfig: ProviderConfig;
let previousEndpoint = '';

async function init() {
  currentConfig = await loadProviderConfig();
  previousEndpoint = currentConfig.endpoint;

  endpointInput.value = currentConfig.endpoint;
  apiKeyInput.value = currentConfig.apiKey;
  modelInput.value = currentConfig.model;
  targetLangSelect.value = currentConfig.targetLanguage;

  updateTranslateButton();
  await queryCurrentStatus();
}

function updateTranslateButton() {
  const configured = isProviderConfigured(currentConfig);
  translateBtn.disabled = !configured;
  configWarning.classList.toggle('hidden', configured);
}

// Save settings
saveBtn.addEventListener('click', async () => {
  const newConfig: Partial<ProviderConfig> = {
    endpoint: endpointInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    targetLanguage: targetLangSelect.value,
  };

  if (newConfig.endpoint && newConfig.endpoint !== previousEndpoint) {
    try {
      const granted = await requestEndpointPermission(newConfig.endpoint);
      if (!granted) {
        showTestResult('需要授权才能访问翻译服务', 'error');
        return;
      }
      if (previousEndpoint) {
        await removeEndpointPermission(previousEndpoint).catch(() => {});
      }
      previousEndpoint = newConfig.endpoint;
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
      if (status.progress) {
        const pct = Math.round((status.progress.completed / status.progress.total) * 100);
        statusBar.textContent = `翻译中... ${pct}%`;
        statusBar.className = 'translating';
      }
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
