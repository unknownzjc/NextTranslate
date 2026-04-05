import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fnv1a, Translator } from '../../src/content/translator';

describe('fnv1a hash', () => {
  it('相同输入产生相同 hash', () => {
    const hash = fnv1a('hello\0Simplified Chinese');
    const hash2 = fnv1a('hello\0Simplified Chinese');
    expect(hash).toBe(hash2);
  });

  it('不同语言产生不同 hash', () => {
    const hash1 = fnv1a('hello\0Simplified Chinese');
    const hash2 = fnv1a('hello\0Japanese');
    expect(hash1).not.toBe(hash2);
  });
});

describe('Translator incremental re-render handling', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><p id="p1">Hello world from translator test.</p></main>';

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        sendMessage: vi.fn((message: { type: string }) => {
          if (message.type === 'TRANSLATE_BATCH') {
            return Promise.resolve({ batchId: 'b1', translations: ['你好，翻译测试。'] });
          }
          return Promise.resolve({});
        }),
      },
    });
  });

  it('当源元素已翻译但译文节点丢失时，应重新视为待处理内容', async () => {
    const container = document.querySelector('main')!;

    let translator!: Translator;
    await new Promise<void>((resolve) => {
      translator = new Translator({
        onBatchTranslated: () => {},
        onProgress: () => {},
        onComplete: () => resolve(),
        onError: () => resolve(),
        onCancelled: () => resolve(),
      });
      void translator.start(container, 'Simplified Chinese');
    });

    expect(translator.hasPendingWork(container, { shouldSkipElement: () => true })).toBe(false);
    expect(translator.hasPendingWork(container, { shouldSkipElement: () => false })).toBe(true);
  });

  it('后台返回 cancelled 时会重试同一批次，而不是永久卡住', async () => {
    vi.useFakeTimers();

    document.body.innerHTML = '<main><p id="p1">Hello world from retry test.</p></main>';
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ batchId: 'b1', translations: [], cancelled: true })
      .mockResolvedValueOnce({ batchId: 'b1', translations: ['取消后重试成功'] });

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        sendMessage,
      },
    });

    const translated: string[] = [];
    const translator = new Translator({
      onBatchTranslated: (_batchSeq, _elements, translations) => {
        translated.push(...translations);
      },
      onProgress: () => {},
      onComplete: () => {},
      onError: () => {},
      onCancelled: () => {},
    });

    void translator.start(document.querySelector('main')!, 'Simplified Chinese');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(translated).toContain('取消后重试成功');
  });
});
