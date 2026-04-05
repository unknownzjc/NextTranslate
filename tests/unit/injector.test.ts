import { describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '../../src/content/injector';

describe('Injector', () => {
  let injector: Injector;

  beforeEach(() => {
    document.body.innerHTML = '<div id="content"><p id="p1">Hello world</p><p id="p2">Good morning</p></div>';
    injector = new Injector();
  });

  it('在段落内部插入位于原文下方的译文块', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    const translation = p1.querySelector('.nt-translation');
    expect(translation).not.toBeNull();
    expect(translation!.classList.contains('nt-translation')).toBe(true);
    expect(translation!.textContent).toBe('你好世界');
  });

  it('译文使用 textContent 赋值（防 XSS）', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '<script>alert("xss")</script>');
    const translation = p1.querySelector('.nt-translation');
    expect(translation!.innerHTML).not.toContain('<script>');
    expect(translation!.textContent).toBe('<script>alert("xss")</script>');
  });

  it('source 和 translation 通过 data-nt-id 关联', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    const ntId = p1.getAttribute('data-nt-id');
    expect(ntId).not.toBeNull();
    const translation = p1.querySelector('.nt-translation');
    expect(translation!.getAttribute('data-nt-id')).toBe(ntId);
  });

  it('切换显示/隐藏', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    injector.setVisibility(false);
    const translation = p1.querySelector('.nt-translation') as HTMLElement;
    expect(translation.style.display).toBe('none');
    injector.setVisibility(true);
    expect(translation.style.display).toBe('');
  });

  it('removeAll 移除所有译文', () => {
    const p1 = document.getElementById('p1')!;
    const p2 = document.getElementById('p2')!;
    injector.insertTranslation(p1, '你好世界');
    injector.insertTranslation(p2, '早上好');
    injector.removeAll();
    expect(document.querySelectorAll('.nt-translation').length).toBe(0);
  });

  it('不重复插入同一元素的译文', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    injector.insertTranslation(p1, '你好世界 v2');
    const translations = document.querySelectorAll('.nt-translation');
    expect(translations.length).toBe(1);
    expect(translations[0].textContent).toBe('你好世界 v2');
  });

  it('hasTranslation 可识别译文是否仍挂载在源节点上', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    expect(injector.hasTranslation(p1)).toBe(true);

    p1.querySelector('.nt-translation')?.remove();
    expect(injector.hasTranslation(p1)).toBe(false);
  });
});
