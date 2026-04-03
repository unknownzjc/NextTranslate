import { describe, it, expect } from 'vitest';
import { DEFAULT_PROVIDER_CONFIG } from '@shared/types';

describe('项目设置验证', () => {
  it('默认配置应有正确的目标语言', () => {
    expect(DEFAULT_PROVIDER_CONFIG.targetLanguage).toBe('Simplified Chinese');
  });

  it('默认 jsonMode 应为 auto', () => {
    expect(DEFAULT_PROVIDER_CONFIG.jsonMode).toBe('auto');
  });
});
