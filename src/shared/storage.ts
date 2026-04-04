import { ProviderConfig, DEFAULT_PROVIDER_CONFIG } from './types';

const SYNC_KEYS = ['nt:endpoint', 'nt:model', 'nt:targetLanguage', 'nt:jsonMode'] as const;
const LOCAL_KEYS = ['nt:apiKey'] as const;

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get([...SYNC_KEYS]),
    chrome.storage.local.get([...LOCAL_KEYS]),
  ]);

  // API Key: prefer sync (user enabled sync), fallback to local
  const syncApiKey = (await chrome.storage.sync.get(['nt:apiKey']))['nt:apiKey'];

  return {
    endpoint: (syncData['nt:endpoint'] as string | undefined) ?? DEFAULT_PROVIDER_CONFIG.endpoint,
    apiKey: (syncApiKey as string | undefined) ?? (localData['nt:apiKey'] as string | undefined) ?? DEFAULT_PROVIDER_CONFIG.apiKey,
    model: (syncData['nt:model'] as string | undefined) ?? DEFAULT_PROVIDER_CONFIG.model,
    targetLanguage: (syncData['nt:targetLanguage'] as string | undefined) ?? DEFAULT_PROVIDER_CONFIG.targetLanguage,
    jsonMode: (syncData['nt:jsonMode'] as ProviderConfig['jsonMode'] | undefined) ?? DEFAULT_PROVIDER_CONFIG.jsonMode,
  };
}

export async function saveProviderConfig(config: Partial<ProviderConfig>): Promise<void> {
  const syncItems: Record<string, unknown> = {};
  const localItems: Record<string, unknown> = {};

  if (config.endpoint !== undefined) {
    syncItems['nt:endpoint'] = config.endpoint.replace(/\/+$/, '');
  }
  if (config.model !== undefined) {
    syncItems['nt:model'] = config.model;
  }
  if (config.targetLanguage !== undefined) {
    syncItems['nt:targetLanguage'] = config.targetLanguage;
  }
  if (config.jsonMode !== undefined) {
    syncItems['nt:jsonMode'] = config.jsonMode;
  }
  if (config.apiKey !== undefined) {
    localItems['nt:apiKey'] = config.apiKey;
  }

  const promises: Promise<void>[] = [];
  if (Object.keys(syncItems).length > 0) {
    promises.push(chrome.storage.sync.set(syncItems));
  }
  if (Object.keys(localItems).length > 0) {
    promises.push(chrome.storage.local.set(localItems));
  }
  await Promise.all(promises);
}

export function isProviderConfigured(config: ProviderConfig): boolean {
  return config.endpoint !== '' && config.apiKey !== '' && config.model !== '';
}
