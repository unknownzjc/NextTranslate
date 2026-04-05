import { describe, expect, it } from 'vitest';
import { getMainDomain, getSiteKeyFromUrl, isInjectablePageUrl } from '@shared/site';

describe('site helpers', () => {
  it('主域名规则会归一化常见站点', () => {
    expect(getMainDomain('www.github.com')).toBe('github.com');
    expect(getMainDomain('docs.github.com')).toBe('github.com');
    expect(getMainDomain('news.ycombinator.com')).toBe('ycombinator.com');
    expect(getMainDomain('foo.example.co.uk')).toBe('example.co.uk');
    expect(getMainDomain('twitter.com')).toBe('x.com');
    expect(getMainDomain('x.com')).toBe('x.com');
  });

  it('会保留 localhost 和 IP 作为站点 key', () => {
    expect(getMainDomain('localhost')).toBe('localhost');
    expect(getMainDomain('127.0.0.1')).toBe('127.0.0.1');
  });

  it('从 URL 提取站点 key 时只接受可注入页面', () => {
    expect(getSiteKeyFromUrl('https://docs.github.com/en/get-started')).toBe('github.com');
    expect(getSiteKeyFromUrl('http://localhost:3000/foo')).toBe('localhost');
    expect(getSiteKeyFromUrl('chrome://extensions')).toBeNull();
    expect(getSiteKeyFromUrl('chrome-extension://abc/popup.html')).toBeNull();
    expect(getSiteKeyFromUrl('not-a-url')).toBeNull();
    expect(isInjectablePageUrl('https://example.com')).toBe(true);
    expect(isInjectablePageUrl('chrome://settings')).toBe(false);
  });
});
