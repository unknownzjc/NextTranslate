export interface ProviderConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  jsonMode: 'auto' | 'enabled' | 'disabled';
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  endpoint: '',
  apiKey: '',
  model: '',
  targetLanguage: 'Simplified Chinese',
  jsonMode: 'auto',
};
