export interface ProviderConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  jsonMode: 'auto' | 'enabled' | 'disabled';
}

export interface SiteTranslationSettings {
  autoTranslate: boolean;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  endpoint: '',
  apiKey: '',
  model: '',
  targetLanguage: 'Simplified Chinese',
  jsonMode: 'auto',
};

export const DEFAULT_SITE_TRANSLATION_SETTINGS: SiteTranslationSettings = {
  autoTranslate: false,
};
