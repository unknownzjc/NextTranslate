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
  permissions: {
    request: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve(true)),
  },
});

import { loadProviderConfig, saveProviderConfig, requestEndpointPermission } from '@shared/storage';
import { DEFAULT_PROVIDER_CONFIG } from '@shared/types';

describe('storage', () => {
  beforeEach(() => {
    mockStorage.sync = {};
    mockStorage.local = {};
  });

  it('未配置时返回默认值', async () => {
    const config = await loadProviderConfig();
    expect(config).toEqual(DEFAULT_PROVIDER_CONFIG);
  });

  it('保存并加载非敏感设置到 sync', async () => {
    await saveProviderConfig({ endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    const config = await loadProviderConfig();
    expect(config.endpoint).toBe('https://api.openai.com/v1');
    expect(config.model).toBe('gpt-4o-mini');
  });

  it('API Key 默认存储在 local', async () => {
    await saveProviderConfig({ apiKey: 'sk-test123' });
    expect(mockStorage.local['nt:apiKey']).toBe('sk-test123');
    expect(mockStorage.sync['nt:apiKey']).toBeUndefined();
  });

  it('endpoint 自动去除末尾斜杠', async () => {
    await saveProviderConfig({ endpoint: 'https://api.openai.com/v1/' });
    const config = await loadProviderConfig();
    expect(config.endpoint).toBe('https://api.openai.com/v1');
  });

  it('requestEndpointPermission 请求正确的 origin 权限', async () => {
    const granted = await requestEndpointPermission('https://api.deepseek.com/v1');
    expect(granted).toBe(true);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://api.deepseek.com/*'],
    });
  });
});
