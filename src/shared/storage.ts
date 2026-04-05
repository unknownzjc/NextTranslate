import {
  DEFAULT_PROVIDER_CONFIG,
  DEFAULT_SITE_TRANSLATION_SETTINGS,
  type ProviderConfig,
  type SiteTranslationSettings,
} from './types';
import { getSiteKeyFromUrl } from './site';
import {
  DEFAULT_PROVIDER_ID,
  detectProviderFromEndpoint,
  getDefaultProviderConfig,
  isProviderId,
  normalizeEndpoint,
  type ProviderId,
} from './providers';

const ACTIVE_PROVIDER_KEY = 'nt:activeProvider';
const PROVIDER_CONFIGS_KEY = 'nt:providerConfigs';
const PROVIDER_API_KEYS_KEY = 'nt:providerApiKeys';
const TARGET_LANGUAGE_KEY = 'nt:targetLanguage';
const AUTO_TRANSLATE_SITES_KEY = 'nt:autoTranslateSites';

const LEGACY_SYNC_KEYS = ['nt:endpoint', 'nt:model', 'nt:targetLanguage', 'nt:jsonMode'] as const;
const LEGACY_LOCAL_KEYS = ['nt:apiKey'] as const;

const SYNC_KEYS = [
  ACTIVE_PROVIDER_KEY,
  PROVIDER_CONFIGS_KEY,
  TARGET_LANGUAGE_KEY,
  AUTO_TRANSLATE_SITES_KEY,
  ...LEGACY_SYNC_KEYS,
] as const;
const LOCAL_KEYS = [PROVIDER_API_KEYS_KEY, ...LEGACY_LOCAL_KEYS] as const;

type ProviderProfile = Pick<ProviderConfig, 'endpoint' | 'model' | 'jsonMode'>;
type StoredProviderProfiles = Partial<Record<ProviderId, Partial<ProviderProfile>>>;
type StoredProviderApiKeys = Partial<Record<ProviderId, string>>;
type StoredAutoTranslateSites = Record<string, boolean>;

interface LegacyProviderState {
  hasData: boolean;
  providerId: ProviderId;
  profile: Partial<ProviderProfile>;
  apiKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJsonMode(value: unknown): ProviderConfig['jsonMode'] | undefined {
  return value === 'auto' || value === 'enabled' || value === 'disabled' ? value : undefined;
}

function getStoredProviderProfiles(syncData: Record<string, unknown>): StoredProviderProfiles {
  const rawProfiles = syncData[PROVIDER_CONFIGS_KEY];
  if (!isRecord(rawProfiles)) {
    return {};
  }

  const profiles: StoredProviderProfiles = {};
  for (const [providerId, rawProfile] of Object.entries(rawProfiles)) {
    if (!isProviderId(providerId) || !isRecord(rawProfile)) {
      continue;
    }

    const profile: Partial<ProviderProfile> = {};
    if (typeof rawProfile.endpoint === 'string') {
      profile.endpoint = normalizeEndpoint(rawProfile.endpoint);
    }
    if (typeof rawProfile.model === 'string') {
      profile.model = rawProfile.model;
    }
    const jsonMode = parseJsonMode(rawProfile.jsonMode);
    if (jsonMode) {
      profile.jsonMode = jsonMode;
    }

    profiles[providerId] = profile;
  }

  return profiles;
}

function getStoredProviderApiKeys(localData: Record<string, unknown>): StoredProviderApiKeys {
  const rawApiKeys = localData[PROVIDER_API_KEYS_KEY];
  if (!isRecord(rawApiKeys)) {
    return {};
  }

  const apiKeys: StoredProviderApiKeys = {};
  for (const [providerId, apiKey] of Object.entries(rawApiKeys)) {
    if (isProviderId(providerId) && typeof apiKey === 'string') {
      apiKeys[providerId] = apiKey;
    }
  }

  return apiKeys;
}

function getStoredAutoTranslateSites(syncData: Record<string, unknown>): StoredAutoTranslateSites {
  const rawSites = syncData[AUTO_TRANSLATE_SITES_KEY];
  if (!isRecord(rawSites)) {
    return {};
  }

  const sites: StoredAutoTranslateSites = {};
  for (const [siteKey, enabled] of Object.entries(rawSites)) {
    if (typeof siteKey === 'string' && enabled === true) {
      sites[siteKey] = true;
    }
  }

  return sites;
}

function getLegacyProviderState(
  syncData: Record<string, unknown>,
  localData: Record<string, unknown>,
): LegacyProviderState {
  const endpoint = typeof syncData['nt:endpoint'] === 'string'
    ? normalizeEndpoint(syncData['nt:endpoint'])
    : undefined;
  const model = typeof syncData['nt:model'] === 'string'
    ? syncData['nt:model']
    : undefined;
  const jsonMode = parseJsonMode(syncData['nt:jsonMode']);
  const apiKey = typeof localData['nt:apiKey'] === 'string'
    ? localData['nt:apiKey']
    : undefined;

  return {
    hasData: endpoint !== undefined || model !== undefined || jsonMode !== undefined || apiKey !== undefined,
    providerId: detectProviderFromEndpoint(endpoint ?? ''),
    profile: {
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(jsonMode !== undefined ? { jsonMode } : {}),
    },
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

function mergeLegacyProviderState(
  profiles: StoredProviderProfiles,
  apiKeys: StoredProviderApiKeys,
  legacyState: LegacyProviderState,
): { profiles: StoredProviderProfiles; apiKeys: StoredProviderApiKeys } {
  const mergedProfiles = { ...profiles };
  const mergedApiKeys = { ...apiKeys };

  if (legacyState.hasData && !mergedProfiles[legacyState.providerId]) {
    mergedProfiles[legacyState.providerId] = legacyState.profile;
  }
  if (legacyState.apiKey !== undefined && mergedApiKeys[legacyState.providerId] === undefined) {
    mergedApiKeys[legacyState.providerId] = legacyState.apiKey;
  }

  return { profiles: mergedProfiles, apiKeys: mergedApiKeys };
}

function resolveActiveProvider(
  syncData: Record<string, unknown>,
  profiles: StoredProviderProfiles,
  apiKeys: StoredProviderApiKeys,
  legacyState: LegacyProviderState,
): ProviderId {
  const storedActiveProvider = syncData[ACTIVE_PROVIDER_KEY];
  if (isProviderId(storedActiveProvider)) {
    return storedActiveProvider;
  }

  if (legacyState.hasData) {
    return legacyState.providerId;
  }

  const firstConfiguredProvider = [...Object.keys(profiles), ...Object.keys(apiKeys)]
    .find((providerId): providerId is ProviderId => isProviderId(providerId));

  return firstConfiguredProvider ?? DEFAULT_PROVIDER_ID;
}

function getTargetLanguage(syncData: Record<string, unknown>): string {
  return typeof syncData[TARGET_LANGUAGE_KEY] === 'string'
    ? syncData[TARGET_LANGUAGE_KEY]
    : DEFAULT_PROVIDER_CONFIG.targetLanguage;
}

function hasStoredProviderState(
  syncData: Record<string, unknown>,
  profiles: StoredProviderProfiles,
  apiKeys: StoredProviderApiKeys,
  legacyState: LegacyProviderState,
): boolean {
  return isProviderId(syncData[ACTIVE_PROVIDER_KEY])
    || Object.keys(profiles).length > 0
    || Object.keys(apiKeys).length > 0
    || legacyState.hasData;
}

function buildProviderConfig(
  providerId: ProviderId,
  profiles: StoredProviderProfiles,
  apiKeys: StoredProviderApiKeys,
  targetLanguage: string,
): ProviderConfig {
  const defaults = getDefaultProviderConfig(providerId);
  const profile = profiles[providerId] ?? {};

  return {
    ...defaults,
    endpoint: profile.endpoint ?? defaults.endpoint,
    apiKey: apiKeys[providerId] ?? defaults.apiKey,
    model: profile.model ?? defaults.model,
    targetLanguage,
    jsonMode: profile.jsonMode ?? defaults.jsonMode,
  };
}

async function readStorageState() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get([...SYNC_KEYS]),
    chrome.storage.local.get([...LOCAL_KEYS]),
  ]);

  const profiles = getStoredProviderProfiles(syncData);
  const apiKeys = getStoredProviderApiKeys(localData);
  const legacyState = getLegacyProviderState(syncData, localData);
  const mergedState = mergeLegacyProviderState(profiles, apiKeys, legacyState);

  return {
    syncData,
    localData,
    targetLanguage: getTargetLanguage(syncData),
    legacyState,
    profiles: mergedState.profiles,
    apiKeys: mergedState.apiKeys,
    autoTranslateSites: getStoredAutoTranslateSites(syncData),
  };
}

export async function loadActiveProviderId(): Promise<ProviderId> {
  const state = await readStorageState();
  return resolveActiveProvider(state.syncData, state.profiles, state.apiKeys, state.legacyState);
}

export async function loadProviderConfig(providerId?: ProviderId): Promise<ProviderConfig> {
  const state = await readStorageState();

  if (!providerId && !hasStoredProviderState(state.syncData, state.profiles, state.apiKeys, state.legacyState)) {
    return {
      ...DEFAULT_PROVIDER_CONFIG,
      targetLanguage: state.targetLanguage,
    };
  }

  const targetProviderId = providerId
    ?? resolveActiveProvider(state.syncData, state.profiles, state.apiKeys, state.legacyState);

  return buildProviderConfig(targetProviderId, state.profiles, state.apiKeys, state.targetLanguage);
}

export async function saveProviderConfig(config: Partial<ProviderConfig>, providerId?: ProviderId): Promise<void> {
  const state = await readStorageState();
  const targetProviderId = providerId
    ?? resolveActiveProvider(state.syncData, state.profiles, state.apiKeys, state.legacyState);

  const syncItems: Record<string, unknown> = {};
  const localItems: Record<string, unknown> = {};

  if (providerId !== undefined) {
    syncItems[ACTIVE_PROVIDER_KEY] = providerId;
  }

  const nextProfile = { ...(state.profiles[targetProviderId] ?? {}) };
  let profileChanged = false;

  if (config.endpoint !== undefined) {
    nextProfile.endpoint = normalizeEndpoint(config.endpoint);
    profileChanged = true;
  }
  if (config.model !== undefined) {
    nextProfile.model = config.model;
    profileChanged = true;
  }
  if (config.jsonMode !== undefined) {
    nextProfile.jsonMode = config.jsonMode;
    profileChanged = true;
  }

  if (profileChanged) {
    syncItems[PROVIDER_CONFIGS_KEY] = {
      ...state.profiles,
      [targetProviderId]: nextProfile,
    } satisfies StoredProviderProfiles;
    syncItems[ACTIVE_PROVIDER_KEY] = targetProviderId;
  }

  if (config.targetLanguage !== undefined) {
    syncItems[TARGET_LANGUAGE_KEY] = config.targetLanguage;
  }

  if (config.apiKey !== undefined) {
    localItems[PROVIDER_API_KEYS_KEY] = {
      ...state.apiKeys,
      [targetProviderId]: config.apiKey,
    } satisfies StoredProviderApiKeys;
    syncItems[ACTIVE_PROVIDER_KEY] = targetProviderId;
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

export async function loadSiteTranslationSettings(siteKey: string): Promise<SiteTranslationSettings> {
  if (!siteKey) {
    return DEFAULT_SITE_TRANSLATION_SETTINGS;
  }

  const state = await readStorageState();
  return {
    autoTranslate: state.autoTranslateSites[siteKey] === true,
  };
}

export async function saveSiteTranslationSettings(siteKey: string, settings: SiteTranslationSettings): Promise<void> {
  if (!siteKey) {
    return;
  }

  const state = await readStorageState();
  const nextSites = { ...state.autoTranslateSites };

  if (settings.autoTranslate) {
    nextSites[siteKey] = true;
  } else {
    delete nextSites[siteKey];
  }

  await chrome.storage.sync.set({
    [AUTO_TRANSLATE_SITES_KEY]: nextSites,
  });
}

export async function isAutoTranslateEnabledForUrl(url?: string | null): Promise<boolean> {
  const siteKey = getSiteKeyFromUrl(url);
  if (!siteKey) {
    return false;
  }

  const settings = await loadSiteTranslationSettings(siteKey);
  return settings.autoTranslate;
}

export function isProviderConfigured(config: ProviderConfig): boolean {
  return config.endpoint !== '' && config.apiKey !== '' && config.model !== '';
}
