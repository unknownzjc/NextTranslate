import { describe, expect, it } from 'vitest';
import { isInjectablePageUrl } from '../../src/shared/content-ui';

describe('isInjectablePageUrl', () => {
  it('允许 http 和 https 页面', () => {
    expect(isInjectablePageUrl('https://example.com/article')).toBe(true);
    expect(isInjectablePageUrl('http://localhost:3000')).toBe(true);
  });

  it('拒绝浏览器内部和扩展页面', () => {
    expect(isInjectablePageUrl('chrome://extensions')).toBe(false);
    expect(isInjectablePageUrl('chrome-extension://abc/popup.html')).toBe(false);
  });

  it('拒绝空值和非法 URL', () => {
    expect(isInjectablePageUrl('')).toBe(false);
    expect(isInjectablePageUrl(undefined)).toBe(false);
    expect(isInjectablePageUrl('not-a-url')).toBe(false);
  });
});
