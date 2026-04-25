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

  it('翻译结果数量不匹配时会标记批次失败，避免 loading 永久残留', async () => {
    const container = document.createElement('main');
    const failedEl = document.createElement('p');
    const failedText = 'Mismatch response paragraph should not stay loading forever.';
    failedEl.textContent = failedText;
    container.appendChild(failedEl);
    document.body.innerHTML = '';
    document.body.appendChild(container);

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        sendMessage: vi.fn((message: { type: string }) => {
          if (message.type === 'TRANSLATE_BATCH') {
            return Promise.resolve({ batchId: 'mismatch-batch', translations: [] });
          }
          return Promise.resolve({});
        }),
      },
    });

    const failedBlocks: Array<{ element: Element; error: string }> = [];
    const progress: Array<[number, number]> = [];

    await new Promise<void>((resolve, reject) => {
      const translator = new Translator({
        onBatchTranslated: () => reject(new Error('unexpected translation')),
        onProgress: (completed, total) => progress.push([completed, total]),
        onComplete: () => resolve(),
        onError: (error) => reject(new Error(`unexpected onError: ${error}`)),
        onCancelled: () => reject(new Error('unexpected cancel')),
        onBlockFailed: (element, error) => failedBlocks.push({ element, error }),
      });

      void translator.start(container, 'Simplified Chinese', {
        paragraphs: [{ element: failedEl, text: failedText, codeMap: new Map() }],
      });
    });

    expect(failedBlocks).toEqual([{ element: failedEl, error: '翻译结果数量不匹配，请重试' }]);
    expect(progress.at(-1)).toEqual([1, 1]);
  });

  it('单批次失败不会中止整页，其他段落仍会继续完成', async () => {
    const container = document.createElement('main');
    const failedEl = document.createElement('p');
    const successEl = document.createElement('p');
    const failedText = 'F'.repeat(7000);
    const successText = 'S'.repeat(7000);
    failedEl.textContent = failedText;
    successEl.textContent = successText;
    container.append(failedEl, successEl);
    document.body.innerHTML = '';
    document.body.appendChild(container);

    const sendMessage = vi.fn((message: { type: string; texts?: string[] }) => {
      if (message.type !== 'TRANSLATE_BATCH') {
        return Promise.resolve({});
      }

      if (message.texts?.[0] === failedText) {
        return Promise.resolve({ batchId: 'failed-batch', translations: [], error: 'batch failed' });
      }

      return Promise.resolve({ batchId: 'success-batch', translations: ['成功段落译文'] });
    });

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        sendMessage,
      },
    });

    const progress: Array<[number, number]> = [];
    const failedBlocks: Array<{ element: Element; error: string }> = [];
    const translatedBlocks: Array<{ element: Element; text: string }> = [];

    await new Promise<void>((resolve, reject) => {
      const translator = new Translator({
        onBatchTranslated: (_batchSeq, elements, translations) => {
          translatedBlocks.push({ element: elements[0], text: translations[0] });
        },
        onProgress: (completed, total) => {
          progress.push([completed, total]);
        },
        onComplete: () => resolve(),
        onError: (error) => reject(new Error(`unexpected onError: ${error}`)),
        onCancelled: () => reject(new Error('unexpected cancel')),
        onBlockFailed: (element, error) => {
          failedBlocks.push({ element, error });
        },
      });

      void translator.start(container, 'Simplified Chinese', {
        paragraphs: [
          { element: failedEl, text: failedText, codeMap: new Map() },
          { element: successEl, text: successText, codeMap: new Map() },
        ],
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(failedBlocks).toEqual([{ element: failedEl, error: 'batch failed' }]);
    expect(translatedBlocks).toEqual([{ element: successEl, text: '成功段落译文' }]);
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it('失败段落同文案默认跳过，显式重试或文案变化后才重新进入待翻译', async () => {
    const container = document.createElement('main');
    const failedEl = document.createElement('p');
    const failedText = 'R'.repeat(7000);
    failedEl.textContent = failedText;
    container.appendChild(failedEl);
    document.body.innerHTML = '';
    document.body.appendChild(container);

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        sendMessage: vi.fn((message: { type: string }) => {
          if (message.type === 'TRANSLATE_BATCH') {
            return Promise.resolve({ batchId: 'failed-batch', translations: [], error: 'batch failed' });
          }
          return Promise.resolve({});
        }),
      },
    });

    let translator!: Translator;
    await new Promise<void>((resolve, reject) => {
      translator = new Translator({
        onBatchTranslated: () => {},
        onProgress: () => {},
        onComplete: () => resolve(),
        onError: (error) => reject(new Error(`unexpected onError: ${error}`)),
        onCancelled: () => reject(new Error('unexpected cancel')),
        onBlockFailed: () => {},
      });

      void translator.start(container, 'Simplified Chinese', {
        paragraphs: [{ element: failedEl, text: failedText, codeMap: new Map() }],
      });
    });

    expect(translator.hasPendingWork(container, {
      paragraphs: [{ element: failedEl, text: failedText, codeMap: new Map() }],
      shouldSkipElement: () => false,
    })).toBe(false);
    expect(translator.hasPendingWork(container, {
      paragraphs: [{ element: failedEl, text: failedText, codeMap: new Map() }],
      shouldSkipElement: () => false,
      retryFailed: true,
    })).toBe(true);
    expect(translator.hasPendingWork(container, {
      paragraphs: [{ element: failedEl, text: `${failedText} updated`, codeMap: new Map() }],
      shouldSkipElement: () => false,
    })).toBe(true);
  });
});
