import type { ProviderConfig } from './types';
import { DEFAULT_PROVIDER_CONFIG } from './types';

export type ProviderId = 'openai' | 'zhipu' | 'kimi' | 'custom';

export interface ProviderPreset {
  endpoint: string;
  model: string;
}

export const DEFAULT_PROVIDER_ID: ProviderId = 'openai';

export const PROVIDER_PRESETS: Record<Exclude<ProviderId, 'custom'>, ProviderPreset> = {
  openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  kimi: { endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
};

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'openai' || value === 'zhipu' || value === 'kimi' || value === 'custom';
}

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

export function detectProviderFromEndpoint(endpoint: string): ProviderId {
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  for (const [providerId, preset] of Object.entries(PROVIDER_PRESETS) as Array<[Exclude<ProviderId, 'custom'>, ProviderPreset]>) {
    if (normalizedEndpoint === normalizeEndpoint(preset.endpoint)) {
      return providerId;
    }
  }

  return normalizedEndpoint ? 'custom' : DEFAULT_PROVIDER_ID;
}

export function getDefaultProviderConfig(providerId: ProviderId): ProviderConfig {
  const preset = providerId === 'custom' ? undefined : PROVIDER_PRESETS[providerId];

  return {
    ...DEFAULT_PROVIDER_CONFIG,
    endpoint: preset?.endpoint ?? DEFAULT_PROVIDER_CONFIG.endpoint,
    model: preset?.model ?? DEFAULT_PROVIDER_CONFIG.model,
  };
}
