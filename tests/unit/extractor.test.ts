import { describe, it, expect, beforeEach } from 'vitest';
import {
  isChineseDominant,
  shouldSkipElement,
  extractTextWithCodeProtection,
  restoreCodePlaceholders,
  estimateTokens,
  splitIntoBatches,
} from '../../src/content/extractor';

describe('isChineseDominant', () => {
  it('纯中文返回 true', () => {
    expect(isChineseDominant('这是一段中文文字')).toBe(true);
  });

  it('纯英文返回 false', () => {
    expect(isChineseDominant('This is English text')).toBe(false);
  });

  it('中文占比 > 50% 返回 true', () => {
    expect(isChineseDominant('这是一段中文测试文字加上少量English')).toBe(true);
  });

  it('中文占比 < 50% 返回 false', () => {
    expect(isChineseDominant('This is mostly English 少量中文')).toBe(false);
  });

  it('空字符串返回 false', () => {
    expect(isChineseDominant('')).toBe(false);
  });
});

describe('shouldSkipElement', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('跳过 code 元素', () => {
    const el = document.createElement('code');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 pre 元素', () => {
    const el = document.createElement('pre');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 script 元素', () => {
    const el = document.createElement('script');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 style 元素', () => {
    const el = document.createElement('style');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 aria-hidden 元素', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 template 元素', () => {
    const el = document.createElement('template');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('不跳过正常 p 元素', () => {
    const el = document.createElement('p');
    document.body.appendChild(el);
    el.textContent = 'Hello world, this is a test paragraph';
    expect(shouldSkipElement(el)).toBe(false);
  });

  it('跳过 nt- 前缀元素', () => {
    const el = document.createElement('div');
    el.className = 'nt-translation';
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过短文本（< 10 个非空白字符）', () => {
    const el = document.createElement('p');
    document.body.appendChild(el);
    el.textContent = 'Hi';
    expect(shouldSkipElement(el)).toBe(true);
  });
});

describe('extractTextWithCodeProtection', () => {
  it('替换内联 code 为占位符', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Use the <code>useState</code> hook to manage state';
    const { text, codeMap } = extractTextWithCodeProtection(p);
    expect(text).toContain('⟨NT_CODE_0⟩');
    expect(text).not.toContain('useState');
    expect(codeMap.get('⟨NT_CODE_0⟩')).toBe('useState');
  });

  it('多个 code 标签分别替换', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Call <code>fetchData</code> then <code>setState</code>';
    const { text, codeMap } = extractTextWithCodeProtection(p);
    expect(text).toContain('⟨NT_CODE_0⟩');
    expect(text).toContain('⟨NT_CODE_1⟩');
    expect(codeMap.size).toBe(2);
  });

  it('无 code 标签时直接返回文本', () => {
    const p = document.createElement('p');
    p.textContent = 'Simple paragraph without code';
    const { text, codeMap } = extractTextWithCodeProtection(p);
    expect(text).toBe('Simple paragraph without code');
    expect(codeMap.size).toBe(0);
  });
});

describe('restoreCodePlaceholders', () => {
  it('还原占位符为原始代码', () => {
    const codeMap = new Map([['⟨NT_CODE_0⟩', 'useState']]);
    const result = restoreCodePlaceholders('使用 ⟨NT_CODE_0⟩ hook 管理状态', codeMap);
    expect(result).toBe('使用 useState hook 管理状态');
  });

  it('占位符缺失时返回原始文本（降级）', () => {
    const codeMap = new Map([['⟨NT_CODE_0⟩', 'useState']]);
    const result = restoreCodePlaceholders('翻译结果没有占位符', codeMap);
    expect(result).toBe('翻译结果没有占位符');
  });
});

describe('estimateTokens', () => {
  it('英文文本按 1:3 估算', () => {
    const text = 'abc'; // 3 chars → ~1 token
    expect(estimateTokens(text)).toBeCloseTo(1, 0);
  });

  it('CJK 文本按 1:1.5 估算', () => {
    const text = '你好世'; // 3 CJK chars → 2 tokens
    expect(estimateTokens(text)).toBeCloseTo(2, 0);
  });
});

describe('splitIntoBatches', () => {
  it('短段落合并为一批', () => {
    const texts = ['Hello world', 'Foo bar', 'Baz qux'];
    const batches = splitIntoBatches(texts, 2000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([0, 1, 2]);
  });

  it('超长段落单独成批', () => {
    const shortText = 'Hello';
    const longText = 'A'.repeat(6000); // ~2000 tokens, exceeds threshold
    const texts = [shortText, longText, shortText];
    const batches = splitIntoBatches(texts, 2000);
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});
