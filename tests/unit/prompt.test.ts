import { describe, it, expect } from 'vitest';
import {
  buildTranslateRequest,
  parseJsonModeResponse,
  parseSeparatorModeResponse,
  NT_SEPARATOR,
} from '../../src/shared/prompt';

describe('buildTranslateRequest', () => {
  it('JSON mode 构建正确的请求体', () => {
    const req = buildTranslateRequest({
      texts: ['Hello world', 'Good morning'],
      targetLanguage: 'Simplified Chinese',
      model: 'gpt-4o-mini',
      mode: 'json',
    });
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.messages[1].content).toContain('"texts"');
    expect(req.messages[0].content).toContain('Simplified Chinese');
  });

  it('分隔符模式不包含 response_format', () => {
    const req = buildTranslateRequest({
      texts: ['Hello world', 'Good morning'],
      targetLanguage: 'Simplified Chinese',
      model: 'gpt-4o-mini',
      mode: 'separator',
    });
    expect(req.response_format).toBeUndefined();
    expect(req.messages[1].content).toContain(NT_SEPARATOR);
  });

  it('包含术语表', () => {
    const req = buildTranslateRequest({
      texts: ['Hello'],
      targetLanguage: 'Simplified Chinese',
      model: 'gpt-4o-mini',
      mode: 'json',
      glossary: ['Dependency Injection', 'Middleware'],
    });
    expect(req.messages[0].content).toContain('Dependency Injection');
    expect(req.messages[0].content).toContain('Middleware');
  });
});

describe('parseJsonModeResponse', () => {
  it('解析正确的 JSON 响应', () => {
    const raw = '{"translations": ["你好世界", "早上好"]}';
    const result = parseJsonModeResponse(raw, 2);
    expect(result).toEqual({ translations: ['你好世界', '早上好'] });
  });

  it('数量不匹配时返回 null', () => {
    const raw = '{"translations": ["你好世界"]}';
    const result = parseJsonModeResponse(raw, 2);
    expect(result).toBeNull();
  });

  it('非法 JSON 在多段时返回 null', () => {
    const result = parseJsonModeResponse('not json', 2);
    expect(result).toBeNull();
  });

  it('剥离 markdown 代码块后解析', () => {
    const raw = '```json\n{"translations": ["你好"]}\n```';
    const result = parseJsonModeResponse(raw, 1);
    expect(result).toEqual({ translations: ['你好'] });
  });

  it('单段时非法 JSON 不再回退为原始文本', () => {
    const result = parseJsonModeResponse('你好世界', 1);
    expect(result).toBeNull();
  });
});

describe('parseSeparatorModeResponse', () => {
  it('解析正确的分隔符响应', () => {
    const raw = '你好世界\n∥NT∥\n早上好';
    const result = parseSeparatorModeResponse(raw, 2);
    expect(result).toEqual({ translations: ['你好世界', '早上好'] });
  });

  it('宽松模式（分隔符两侧无换行）', () => {
    const raw = '你好世界∥NT∥早上好';
    const result = parseSeparatorModeResponse(raw, 2);
    expect(result).toEqual({ translations: ['你好世界', '早上好'] });
  });

  it('数量不匹配时返回 null', () => {
    const raw = '你好世界\n∥NT∥\n早上好\n∥NT∥\n下午好';
    const result = parseSeparatorModeResponse(raw, 2);
    expect(result).toBeNull();
  });
});
