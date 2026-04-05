import { describe, expect, it, vi } from 'vitest';

type PendingBatch = {
  message: { type: string; batchId: string; texts: string[] };
  resolve: (value: { batchId: string; translations: string[]; error?: string }) => void;
};

function setRect(el: Element, rect: { top: number; bottom: number; left?: number; right?: number; width?: number; height?: number }) {
  const { top, bottom, left = 0, right = 0, width = 0, height = bottom - top } = rect;
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top,
      bottom,
      left,
      right,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

async function flushPromises(times = 6) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('content viewport eager queue loading', () => {
  it('滚动进入视窗的未翻译段落会立即显示 loading，并在当前批次完成后自动接续翻译', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    document.body.innerHTML = `
      <main>
        <p id="p1">Hello world from the first paragraph that should translate immediately.</p>
        <p id="p2">Second paragraph enters viewport later and should show loading immediately.</p>
      </main>
    `;

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
    });

    const p1 = document.getElementById('p1')!;
    const p2 = document.getElementById('p2')!;
    setRect(p1, { top: 20, bottom: 120 });
    setRect(p2, { top: 2000, bottom: 2100 });

    let rafId = 0;
    const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = ++rafId;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        cb(0);
      }, 0);
      rafTimers.set(id, timer);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      const timer = rafTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        rafTimers.delete(id);
      }
    }) as typeof window.cancelAnimationFrame;

    vi.doMock('@shared/storage', () => ({
      loadProviderConfig: vi.fn(async () => ({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'auto',
      })),
      isProviderConfigured: vi.fn(() => true),
      isAutoTranslateEnabledForUrl: vi.fn(async () => false),
    }));

    vi.doMock('@shared/site', async () => {
      const actual = await vi.importActual<typeof import('@shared/site')>('@shared/site');
      return {
        ...actual,
        getMainDomain: vi.fn(() => 'x.com'),
      };
    });

    vi.doMock('../../src/content/extractor', async () => {
      const actual = await vi.importActual<typeof import('../../src/content/extractor')>('../../src/content/extractor');

      return {
        ...actual,
        findMainContainer: vi.fn(async () => document.querySelector('main')!),
        collectParagraphs: vi.fn((container: Element, shouldSkipTranslated = () => false, includeElement = () => true) => {
          return Array.from(container.querySelectorAll('p'))
            .map((element) => {
              const clone = element.cloneNode(true) as Element;
              clone.querySelectorAll('.nt-translation, [data-nt]').forEach((node) => node.remove());
              return {
                element,
                text: clone.textContent?.trim() ?? '',
                codeMap: new Map<string, string>(),
              };
            })
            .filter(({ element, text }) => text.length >= 10 && includeElement(element) && !shouldSkipTranslated(element, text));
        }),
      };
    });

    const pendingBatches: PendingBatch[] = [];
    const runtimeListeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void> = [];

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        onMessage: {
          addListener: vi.fn((listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) => {
            runtimeListeners.push(listener);
          }),
        },
        sendMessage: vi.fn((message: { type: string; batchId?: string; texts?: string[] }) => {
          if (message.type === 'TRANSLATE_BATCH') {
            return new Promise((resolve) => {
              pendingBatches.push({
                message: {
                  type: message.type,
                  batchId: message.batchId!,
                  texts: message.texts ?? [],
                },
                resolve: resolve as PendingBatch['resolve'],
              });
            });
          }
          return Promise.resolve({});
        }),
      },
    });

    await import('../../src/content/index');

    const sendToContent = (message: { type: string }) => {
      let response: unknown;
      for (const listener of runtimeListeners) {
        listener(message, {}, (value) => {
          response = value;
        });
      }
      return response;
    };

    expect(sendToContent({ type: 'TOGGLE_TRANSLATE' })).toEqual({ action: 'started' });
    await flushPromises();

    expect(p1.querySelector('.nt-translation.nt-loading')).not.toBeNull();
    expect(p2.querySelector('.nt-translation.nt-loading')).toBeNull();
    expect(pendingBatches).toHaveLength(1);
    expect(pendingBatches[0].message.texts).toEqual([
      'Hello world from the first paragraph that should translate immediately.',
    ]);

    setRect(p2, { top: 100, bottom: 200 });
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(p2.querySelector('.nt-pending-dots')).not.toBeNull();
    expect(p2.querySelector('.nt-translation.nt-loading')).not.toBeNull();
    expect(pendingBatches).toHaveLength(1);

    const firstBatch = pendingBatches.shift()!;
    firstBatch.resolve({
      batchId: firstBatch.message.batchId,
      translations: ['第一段译文'],
    });
    await flushPromises();

    expect(p1.querySelector('.nt-translation')?.textContent).toBe('第一段译文');
    expect(pendingBatches).toHaveLength(1);
    expect(pendingBatches[0].message.texts).toEqual([
      'Second paragraph enters viewport later and should show loading immediately.',
    ]);

    const secondBatch = pendingBatches.shift()!;
    secondBatch.resolve({
      batchId: secondBatch.message.batchId,
      translations: ['第二段译文'],
    });
    await flushPromises();

    expect(p2.querySelector('.nt-translation')?.textContent).toBe('第二段译文');
    expect(p2.querySelector('.nt-translation')?.classList.contains('nt-loading')).toBe(false);
  });
});

describe('content auto-start message', () => {
  it('START_TRANSLATE_IF_IDLE 只会在 idle 时启动，不会影响已完成译文的显示状态', async () => {
    vi.resetModules();

    document.body.innerHTML = `
      <main>
        <p id="p1">Hello world from the paragraph that should translate once.</p>
      </main>
    `;

    vi.doMock('@shared/storage', () => ({
      loadProviderConfig: vi.fn(async () => ({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'auto',
      })),
      isProviderConfigured: vi.fn(() => true),
      isAutoTranslateEnabledForUrl: vi.fn(async () => false),
    }));

    vi.doMock('../../src/content/extractor', async () => {
      const actual = await vi.importActual<typeof import('../../src/content/extractor')>('../../src/content/extractor');

      return {
        ...actual,
        findMainContainer: vi.fn(async () => document.querySelector('main')!),
        collectParagraphs: vi.fn((container: Element, shouldSkipTranslated = () => false, includeElement = () => true) => {
          return Array.from(container.querySelectorAll('p'))
            .map((element) => ({
              element,
              text: element.textContent?.trim() ?? '',
              codeMap: new Map<string, string>(),
            }))
            .filter(({ element, text }) => text.length >= 10 && includeElement(element) && !shouldSkipTranslated(element, text));
        }),
      };
    });

    const pendingBatches: PendingBatch[] = [];
    const runtimeListeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void> = [];

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        onMessage: {
          addListener: vi.fn((listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void) => {
            runtimeListeners.push(listener);
          }),
        },
        sendMessage: vi.fn((message: { type: string; batchId?: string; texts?: string[] }) => {
          if (message.type === 'TRANSLATE_BATCH') {
            return new Promise((resolve) => {
              pendingBatches.push({
                message: {
                  type: message.type,
                  batchId: message.batchId!,
                  texts: message.texts ?? [],
                },
                resolve: resolve as PendingBatch['resolve'],
              });
            });
          }
          return Promise.resolve({});
        }),
      },
    });

    await import('../../src/content/index');

    const sendToContent = (message: { type: string }) => {
      let response: unknown;
      for (const listener of runtimeListeners) {
        listener(message, {}, (value) => {
          response = value;
        });
      }
      return response;
    };

    expect(sendToContent({ type: 'START_TRANSLATE_IF_IDLE' })).toEqual({ started: true });
    await flushPromises();

    expect(pendingBatches).toHaveLength(1);
    const firstBatch = pendingBatches.shift()!;
    firstBatch.resolve({
      batchId: firstBatch.message.batchId,
      translations: ['首次译文'],
    });
    await flushPromises();

    const translationEl = document.querySelector('.nt-translation') as HTMLElement | null;
    expect(translationEl?.textContent).toBe('首次译文');
    expect(translationEl?.style.display).not.toBe('none');

    expect(sendToContent({ type: 'START_TRANSLATE_IF_IDLE' })).toEqual({ started: false });
    await flushPromises();

    expect(pendingBatches).toHaveLength(0);
    expect((document.querySelector('.nt-translation') as HTMLElement | null)?.textContent).toBe('首次译文');
    expect((document.querySelector('.nt-translation') as HTMLElement | null)?.style.display).not.toBe('none');
  });
});

describe('content SPA auto translate', () => {
  it('站点开启自动翻译后，SPA 路由切换会在新页面内容就绪后自动启动翻译', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    document.body.innerHTML = `
      <main>
        <p>Initial page content that should stay idle before navigation.</p>
      </main>
    `;

    vi.doMock('@shared/storage', () => ({
      loadProviderConfig: vi.fn(async () => ({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'auto',
      })),
      isProviderConfigured: vi.fn(() => true),
      isAutoTranslateEnabledForUrl: vi.fn(async () => true),
    }));

    vi.doMock('../../src/content/extractor', async () => {
      const actual = await vi.importActual<typeof import('../../src/content/extractor')>('../../src/content/extractor');

      return {
        ...actual,
        findMainContainer: vi.fn(async () => document.querySelector('main')!),
        collectParagraphs: vi.fn((container: Element, shouldSkipTranslated = () => false, includeElement = () => true) => {
          return Array.from(container.querySelectorAll('p'))
            .map((element) => ({
              element,
              text: element.textContent?.trim() ?? '',
              codeMap: new Map<string, string>(),
            }))
            .filter(({ element, text }) => text.length >= 10 && includeElement(element) && !shouldSkipTranslated(element, text));
        }),
      };
    });

    const pendingBatches: PendingBatch[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        onMessage: {
          addListener: vi.fn(),
        },
        sendMessage: vi.fn((message: { type: string; batchId?: string; texts?: string[] }) => {
          if (message.type === 'TRANSLATE_BATCH') {
            return new Promise((resolve) => {
              pendingBatches.push({
                message: {
                  type: message.type,
                  batchId: message.batchId!,
                  texts: message.texts ?? [],
                },
                resolve: resolve as PendingBatch['resolve'],
              });
            });
          }
          return Promise.resolve({});
        }),
      },
    });

    await import('../../src/content/index');

    expect(pendingBatches).toHaveLength(0);

    history.pushState({}, '', '/next-article');
    document.body.innerHTML = `
      <main>
        <p>New SPA article content should be translated automatically after navigation.</p>
      </main>
    `;

    await vi.advanceTimersByTimeAsync(320);
    await flushPromises();

    expect(pendingBatches).toHaveLength(1);
    expect(pendingBatches[0].message.texts).toEqual([
      'New SPA article content should be translated automatically after navigation.',
    ]);
  });
});
