import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.storage API
const mockStorage: { sync: Record<string, unknown>; local: Record<string, unknown> } = { sync: {}, local: {} };

const createStorageArea = (getArea: () => Record<string, unknown>) => ({
  get: vi.fn((keys: string[]) => {
    const area = getArea();
    return Promise.resolve(
      Object.fromEntries(keys.filter(k => k in area).map(k => [k, area[k]]))
    );
  }),
  set: vi.fn((items: Record<string, unknown>) => {
    Object.assign(getArea(), items);
    return Promise.resolve();
  }),
  remove: vi.fn((keys: string[]) => {
    const area = getArea();
    keys.forEach(k => delete area[k]);
    return Promise.resolve();
  }),
});

vi.stubGlobal('chrome', {
  storage: {
    sync: createStorageArea(() => mockStorage.sync),
    local: createStorageArea(() => mockStorage.local),
  },
});

import {
  isAutoTranslateEnabledForUrl,
  loadActiveProviderId,
  loadProviderConfig,
  loadSiteTranslationSettings,
  saveProviderConfig,
  saveSiteTranslationSettings,
} from '@shared/storage';
import { DEFAULT_PROVIDER_CONFIG, DEFAULT_SITE_TRANSLATION_SETTINGS } from '@shared/types';

describe('storage', () => {
  beforeEach(() => {
    mockStorage.sync = {};
    mockStorage.local = {};
  });

  it('未配置时返回默认值', async () => {
    const config = await loadProviderConfig();
    expect(config).toEqual(DEFAULT_PROVIDER_CONFIG);
  });

  it('保存并加载当前供应商设置', async () => {
    await saveProviderConfig({ endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, 'openai');
    const config = await loadProviderConfig();

    expect(config.endpoint).toBe('https://api.openai.com/v1');
    expect(config.model).toBe('gpt-4o-mini');
    expect(await loadActiveProviderId()).toBe('openai');
  });

  it('API Key 默认按供应商存储在 local', async () => {
    await saveProviderConfig({ apiKey: 'sk-test123' }, 'openai');
    expect(mockStorage.local['nt:providerApiKeys']).toEqual({ openai: 'sk-test123' });
    expect(mockStorage.sync['nt:apiKey']).toBeUndefined();
  });

  it('endpoint 自动去除末尾斜杠', async () => {
    await saveProviderConfig({ endpoint: 'https://api.openai.com/v1/' }, 'openai');
    const config = await loadProviderConfig('openai');
    expect(config.endpoint).toBe('https://api.openai.com/v1');
  });

  it('每个供应商配置独立保存', async () => {
    await saveProviderConfig({ apiKey: 'sk-openai', model: 'gpt-4o-mini' }, 'openai');
    await saveProviderConfig({ apiKey: 'sk-zhipu', model: 'glm-4-flash' }, 'zhipu');

    const openaiConfig = await loadProviderConfig('openai');
    const zhipuConfig = await loadProviderConfig('zhipu');
    const activeConfig = await loadProviderConfig();

    expect(openaiConfig.apiKey).toBe('sk-openai');
    expect(openaiConfig.model).toBe('gpt-4o-mini');
    expect(zhipuConfig.apiKey).toBe('sk-zhipu');
    expect(zhipuConfig.model).toBe('glm-4-flash');
    expect(activeConfig.apiKey).toBe('sk-zhipu');
    expect(await loadActiveProviderId()).toBe('zhipu');
  });

  it('保存新供应商时保留 legacy 旧配置', async () => {
    mockStorage.sync['nt:endpoint'] = 'https://api.openai.com/v1';
    mockStorage.sync['nt:model'] = 'gpt-4o-mini';
    mockStorage.local['nt:apiKey'] = 'sk-legacy-openai';

    await saveProviderConfig({ apiKey: 'sk-kimi', model: 'moonshot-v1-8k' }, 'kimi');

    const openaiConfig = await loadProviderConfig('openai');
    const kimiConfig = await loadProviderConfig('kimi');

    expect(openaiConfig.apiKey).toBe('sk-legacy-openai');
    expect(openaiConfig.model).toBe('gpt-4o-mini');
    expect(kimiConfig.apiKey).toBe('sk-kimi');
    expect(kimiConfig.model).toBe('moonshot-v1-8k');
  });

  it('站点自动翻译默认关闭', async () => {
    const settings = await loadSiteTranslationSettings('github.com');
    expect(settings).toEqual(DEFAULT_SITE_TRANSLATION_SETTINGS);
  });

  it('保存并读取站点自动翻译开关', async () => {
    await saveSiteTranslationSettings('github.com', { autoTranslate: true });

    expect(mockStorage.sync['nt:autoTranslateSites']).toEqual({ 'github.com': true });
    expect(await loadSiteTranslationSettings('github.com')).toEqual({ autoTranslate: true });
  });

  it('关闭站点自动翻译时会移除对应站点 key', async () => {
    await saveSiteTranslationSettings('github.com', { autoTranslate: true });
    await saveSiteTranslationSettings('github.com', { autoTranslate: false });

    expect(mockStorage.sync['nt:autoTranslateSites']).toEqual({});
    expect(await loadSiteTranslationSettings('github.com')).toEqual({ autoTranslate: false });
  });

  it('按主域名匹配自动翻译站点设置', async () => {
    await saveSiteTranslationSettings('github.com', { autoTranslate: true });

    await expect(isAutoTranslateEnabledForUrl('https://docs.github.com/en/get-started')).resolves.toBe(true);
    await expect(isAutoTranslateEnabledForUrl('https://github.com/features')).resolves.toBe(true);
    await expect(isAutoTranslateEnabledForUrl('https://example.com')).resolves.toBe(false);
  });
});
