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

describe('content segment translation (hover quick translate)', () => {
  async function setupSegmentTest(options?: { siteOverrides?: Record<string, unknown> }) {
    vi.resetModules();

    document.body.innerHTML = `
      <main>
        <p id="p1">Hello world from the first paragraph that should be translatable here.</p>
        <p id="p2">Second paragraph with enough text content for segment translate test.</p>
        <p id="p3">Third paragraph with enough text content for further testing purposes.</p>
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

    vi.doMock('@shared/site', async () => {
      const actual = await vi.importActual<typeof import('@shared/site')>('@shared/site');
      return {
        ...actual,
        getMainDomain: vi.fn(() => options?.siteOverrides?.mainDomain ?? 'example.com'),
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
        resolveHoverParagraphCandidate: vi.fn((target: EventTarget | null) => {
          if (target instanceof Element && target.tagName === 'P') return target;
          return null;
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

    return { pendingBatches, sendToContent };
  }

  async function setupFailedPageTranslation() {
    const context = await setupSegmentTest();
    await flushPromises();

    const { pendingBatches, sendToContent } = context;
    const p1 = document.getElementById('p1')!;
    const p2 = document.getElementById('p2')!;
    const p3 = document.getElementById('p3')!;
    const failedText = 'F'.repeat(7000);
    const successText = 'S'.repeat(7000);
    const thirdText = 'T'.repeat(7000);

    p1.textContent = failedText;
    p2.textContent = successText;
    p3.textContent = thirdText;
    pendingBatches.length = 0;

    expect(sendToContent({ type: 'TOGGLE_TRANSLATE' })).toEqual({ action: 'started' });
    await flushPromises();

    const batchesByText = new Map(
      pendingBatches.map(batch => [batch.message.texts[0], batch]),
    );

    const failedBatch = batchesByText.get(failedText);
    const successBatch = batchesByText.get(successText);
    const thirdBatch = batchesByText.get(thirdText);
    expect(failedBatch).toBeTruthy();
    expect(successBatch).toBeTruthy();
    expect(thirdBatch).toBeTruthy();

    failedBatch!.resolve({
      batchId: failedBatch!.message.batchId,
      translations: [],
      error: '第一段失败',
    });
    successBatch!.resolve({
      batchId: successBatch!.message.batchId,
      translations: ['第二段译文'],
    });
    thirdBatch!.resolve({
      batchId: thirdBatch!.message.batchId,
      translations: ['第三段译文'],
    });
    await flushPromises();
    pendingBatches.length = 0;

    return {
      ...context,
      p1,
      p2,
      p3,
      failedText,
      successText,
      thirdText,
    };
  }

  it('hover 触发 segment translation 成功：仅当前段落出现 loading 与译文', async () => {
    const { pendingBatches } = await setupSegmentTest();
    await flushPromises();

    const p1 = document.getElementById('p1')!;
    const p2 = document.getElementById('p2')!;

    // Clear any stale batches from previous test module imports
    pendingBatches.length = 0;

    // Simulate hover + modifier key trigger via pointermove + keydown
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));

    // Trigger the modifier key
    const keydown = new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true });
    document.dispatchEvent(keydown);
    await flushPromises();

    // p1 should have a loading placeholder
    expect(p1.querySelector('.nt-translation.nt-loading')).not.toBeNull();
    // p2 should NOT have any loading
    expect(p2.querySelector('.nt-translation')).toBeNull();

    // Only p1's text should appear in batches (stale module imports may duplicate)
    const segmentBatches = pendingBatches.filter(b => b.message.texts.includes('Hello world from the first paragraph that should be translatable here.'));
    expect(segmentBatches.length).toBeGreaterThanOrEqual(1);
    // No batch should contain p2 or p3 text
    expect(pendingBatches.every(b => !b.message.texts.some(t => t.includes('Second paragraph')))).toBe(true);

    // Complete all matching batches
    for (const batch of segmentBatches) {
      batch.resolve({
        batchId: batch.message.batchId,
        translations: ['\u7b2c\u4e00\u6bb5\u8bd1\u6587'],
      });
    }
    await flushPromises();

    expect(p1.querySelector('.nt-translation')?.textContent).toBe('\u7b2c\u4e00\u6bb5\u8bd1\u6587');
  });

  it('segment 完成后悬浮球保持 idle 语义', async () => {
    const { pendingBatches } = await setupSegmentTest();
    await flushPromises();
    pendingBatches.length = 0;

    const p1 = document.getElementById('p1')!;

    // Trigger segment translation
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    // Complete
    const batch = pendingBatches.find(b => b.message.texts.some(t => t.includes('first paragraph')));
    expect(batch).toBeTruthy();
    batch!.resolve({
      batchId: batch!.message.batchId,
      translations: ['\u7b2c\u4e00\u6bb5\u8bd1\u6587'],
    });
    await flushPromises();

    // Floating ball should stay idle for segment-only translation
    const fabButton = document.querySelector('.nt-fab-button');
    const fabHint = document.querySelector('.nt-fab-hint');
    expect(fabButton?.getAttribute('data-state')).toBe('idle');
    expect(fabHint?.textContent).toBe('翻译全文');
  });

  it('输入框聚焦时 hover 快捷键不会触发 segment translation', async () => {
    const { pendingBatches } = await setupSegmentTest();
    await flushPromises();
    pendingBatches.length = 0;

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const p1 = document.getElementById('p1')!;
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    expect(pendingBatches).toHaveLength(0);
    expect(p1.querySelector('.nt-translation')).toBeNull();
  });

  it('segment 失败后会清理 placeholder，并恢复到 idle 语义', async () => {
    vi.useFakeTimers();
    const { pendingBatches } = await setupSegmentTest();
    await flushPromises();
    pendingBatches.length = 0;

    const p1 = document.getElementById('p1')!;
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    const batch = pendingBatches.find(b => b.message.texts.some(t => t.includes('first paragraph')));
    expect(batch).toBeTruthy();
    expect(p1.querySelector('.nt-translation.nt-loading')).not.toBeNull();

    batch!.resolve({
      batchId: batch!.message.batchId,
      translations: [],
      error: '翻译失败',
    });
    await flushPromises();

    expect(p1.querySelector('.nt-translation')).toBeNull();

    await vi.advanceTimersByTimeAsync(2800);
    const fabButton = document.querySelector('.nt-fab-button');
    expect(fabButton?.getAttribute('data-state')).toBe('idle');
    vi.useRealTimers();
  });

  it('segment 取消后会清理 placeholder，并允许后续重新翻译', async () => {
    vi.useFakeTimers();
    const { pendingBatches, sendToContent } = await setupSegmentTest();
    await flushPromises();
    pendingBatches.length = 0;

    const p1 = document.getElementById('p1')!;
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    expect(p1.querySelector('.nt-translation.nt-loading')).not.toBeNull();
    expect(sendToContent({ type: 'TOGGLE_TRANSLATE' })).toEqual({ action: 'cancelled' });
    await flushPromises();

    expect(p1.querySelector('.nt-translation')).toBeNull();
    const fabButton = document.querySelector('.nt-fab-button');
    expect(fabButton?.getAttribute('data-state')).toBe('idle');

    pendingBatches.length = 0;
    vi.advanceTimersByTime(1600);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false, bubbles: true }));
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    expect(pendingBatches.some(b => b.message.texts.some(t => t.includes('first paragraph')))).toBe(true);
    vi.useRealTimers();
  });

  it('段落原文变化后，hover quick translate 会将其视为新内容重新翻译', async () => {
    vi.useFakeTimers();
    const { pendingBatches } = await setupSegmentTest();
    await flushPromises();
    pendingBatches.length = 0;

    const p1 = document.getElementById('p1')!;
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    const firstBatch = pendingBatches.find(b => b.message.texts.some(t => t.includes('first paragraph')));
    expect(firstBatch).toBeTruthy();
    firstBatch!.resolve({
      batchId: firstBatch!.message.batchId,
      translations: ['首次译文'],
    });
    await flushPromises();

    pendingBatches.length = 0;
    vi.advanceTimersByTime(1600);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false, bubbles: true }));

    const sourceTextNode = p1.firstChild;
    expect(sourceTextNode?.nodeType).toBe(Node.TEXT_NODE);
    sourceTextNode!.textContent = 'Updated paragraph source that should be translated again after content changes.';

    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    expect(pendingBatches.some(b => b.message.texts.includes('Updated paragraph source that should be translated again after content changes.'))).toBe(true);
    vi.useRealTimers();
  });

  it('done + segment \u70b9\u51fb\u60ac\u6d6e\u7403\u4f1a\u5347\u7ea7\u4e3a\u5168\u6587\u7ffb\u8bd1', async () => {
    const { pendingBatches, sendToContent } = await setupSegmentTest();
    await flushPromises();
    pendingBatches.length = 0;

    const p1 = document.getElementById('p1')!;
    const p2 = document.getElementById('p2')!;

    // First do a segment translation of p1
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    const segBatch = pendingBatches.find(b => b.message.texts.some(t => t.includes('first paragraph')));
    expect(segBatch).toBeTruthy();
    segBatch!.resolve({
      batchId: segBatch!.message.batchId,
      translations: ['\u7b2c\u4e00\u6bb5\u8bd1\u6587'],
    });
    await flushPromises();

    // Clear batches before page upgrade
    pendingBatches.length = 0;

    // Now click floating ball to upgrade to page translation
    const response = sendToContent({ type: 'TOGGLE_TRANSLATE' });
    expect(response).toEqual({ action: 'started' });
    await flushPromises();

    // Should have sent batches for remaining paragraphs, skipping already-translated p1
    const pageBatches = pendingBatches.filter(b => b.message.texts.length > 0);
    expect(pageBatches.length).toBeGreaterThan(0);
    // None of the batches should contain p1's text
    for (const b of pageBatches) {
      expect(b.message.texts).not.toContain('Hello world from the first paragraph that should be translatable here.');
    }
    // p2 should now have loading
    expect(p2.querySelector('.nt-translation')).not.toBeNull();
  });

  it('\u5168\u6587\u7ffb\u8bd1\u8fdb\u884c\u4e2d\u65f6\uff0csegment trigger \u88ab\u963b\u6b62', async () => {
    const { pendingBatches, sendToContent } = await setupSegmentTest();
    await flushPromises();

    // Start page translation
    sendToContent({ type: 'TOGGLE_TRANSLATE' });
    await flushPromises();

    // Page translation in progress
    expect(pendingBatches.length).toBeGreaterThan(0);

    const p2 = document.getElementById('p2')!;
    // Attempt segment trigger while page translating
    p2.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    // Should not have triggered additional segment-specific batches
    // The page translation batches are already in pendingBatches
    const initialBatchCount = pendingBatches.length;
    // No new batches should have been added for segment
    expect(pendingBatches.length).toBe(initialBatchCount);
  });

  it('done + page \u70b9\u51fb\u60ac\u6d6e\u7403\u4ecd\u662f\u663e\u793a/\u9690\u85cf\u5207\u6362', async () => {
    const { pendingBatches, sendToContent } = await setupSegmentTest();
    await flushPromises();

    // Start and complete page translation
    sendToContent({ type: 'TOGGLE_TRANSLATE' });
    await flushPromises();

    while (pendingBatches.length > 0) {
      const batch = pendingBatches.shift()!;
      batch.resolve({
        batchId: batch.message.batchId,
        translations: batch.message.texts.map((_, i) => `\u8bd1\u6587${i}`),
      });
      await flushPromises();
    }

    // Now in done + page, toggle should hide
    const hideResponse = sendToContent({ type: 'TOGGLE_TRANSLATE' });
    expect(hideResponse).toEqual({ action: 'toggled_hidden' });

    // Toggle again should show
    const showResponse = sendToContent({ type: 'TOGGLE_TRANSLATE' });
    expect(showResponse).toEqual({ action: 'toggled_visible' });
  });

  it('page 中单段失败会显示 retry marker，其它段继续完成并保持 done + page 语义', async () => {
    const { p1, p2, sendToContent } = await setupFailedPageTranslation();

    expect(p1.querySelector('.nt-retry-marker')).not.toBeNull();
    expect(p1.querySelector('.nt-translation')).toBeNull();
    expect(p2.querySelector('.nt-translation')?.textContent).toBe('第二段译文');

    const fabButton = document.querySelector('.nt-fab-button');
    expect(fabButton?.getAttribute('data-state')).toBe('translated-visible');
    expect(sendToContent({ type: 'TOGGLE_TRANSLATE' })).toEqual({ action: 'toggled_hidden' });
    expect((p1.querySelector('.nt-retry-marker') as HTMLElement | null)?.style.display).toBe('none');
    expect(sendToContent({ type: 'TOGGLE_TRANSLATE' })).toEqual({ action: 'toggled_visible' });
    expect(p1.querySelector('.nt-retry-marker')).not.toBeNull();
  });

  it('page failed retry icon 点击后只重试该段，并保持 page done 语义', async () => {
    const { pendingBatches, sendToContent, p1, failedText } = await setupFailedPageTranslation();

    const retryButton = p1.querySelector('.nt-retry-marker') as HTMLButtonElement | null;
    expect(retryButton).not.toBeNull();

    retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(pendingBatches).toHaveLength(1);
    expect(pendingBatches[0].message.texts).toEqual([failedText]);

    pendingBatches[0].resolve({
      batchId: pendingBatches[0].message.batchId,
      translations: ['重试成功译文'],
    });
    await flushPromises();

    expect(p1.querySelector('.nt-retry-marker')).toBeNull();
    expect(p1.querySelector('.nt-translation')?.textContent).toBe('重试成功译文');

    const fabButton = document.querySelector('.nt-fab-button');
    expect(fabButton?.getAttribute('data-state')).toBe('translated-visible');
    expect(sendToContent({ type: 'TOGGLE_TRANSLATE' })).toEqual({ action: 'toggled_hidden' });
    expect(sendToContent({ type: 'TOGGLE_TRANSLATE' })).toEqual({ action: 'toggled_visible' });
  });

  it('failed paragraph 原文变化后会重新进入自动翻译候选', async () => {
    vi.useFakeTimers();
    const { pendingBatches, p1 } = await setupFailedPageTranslation();

    const updatedText = 'Updated paragraph source that should re-enter auto translation after a failed run.';
    const sourceTextNode = p1.firstChild;
    expect(sourceTextNode?.nodeType).toBe(Node.TEXT_NODE);
    sourceTextNode!.textContent = updatedText;

    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();

    expect(pendingBatches.some(batch => batch.message.texts.includes(updatedText))).toBe(true);
    expect(p1.querySelector('.nt-retry-marker')).toBeNull();
    expect(p1.querySelector('.nt-translation.nt-loading')).not.toBeNull();
    vi.useRealTimers();
  });


  it('\u672a\u914d\u7f6e provider \u65f6 segment trigger \u53ea\u663e\u793a\u672c\u5730\u9519\u8bef\uff0c\u4e0d\u8fdb\u5165 translating', async () => {
    vi.resetModules();

    document.body.innerHTML = `
      <main>
        <p id="p1">Hello world from the first paragraph that should be translatable here.</p>
      </main>
    `;

    vi.doMock('@shared/storage', () => ({
      loadProviderConfig: vi.fn(async () => ({
        endpoint: '',
        apiKey: '',
        model: '',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'auto',
      })),
      isProviderConfigured: vi.fn(() => false),
      isAutoTranslateEnabledForUrl: vi.fn(async () => false),
    }));

    vi.doMock('../../src/content/extractor', async () => {
      const actual = await vi.importActual<typeof import('../../src/content/extractor')>('../../src/content/extractor');
      return {
        ...actual,
        findMainContainer: vi.fn(async () => document.querySelector('main')!),
        collectParagraphs: vi.fn(() => []),
        resolveHoverParagraphCandidate: vi.fn((target: EventTarget | null) => {
          if (target instanceof Element && target.tagName === 'P') return target;
          return null;
        }),
      };
    });

    const pendingBatches: PendingBatch[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn((message: { type: string; batchId?: string; texts?: string[] }) => {
          if (message.type === 'TRANSLATE_BATCH') {
            return new Promise((resolve) => {
              pendingBatches.push({
                message: { type: message.type, batchId: message.batchId!, texts: message.texts ?? [] },
                resolve: resolve as PendingBatch['resolve'],
              });
            });
          }
          return Promise.resolve({});
        }),
      },
    });

    await import('../../src/content/index');
    await flushPromises();
    pendingBatches.length = 0;

    const p1 = document.getElementById('p1')!;
    p1.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    await flushPromises();

    // Should show error on floating ball
    const fabButton = document.querySelector('.nt-fab-button');
    expect(fabButton?.getAttribute('data-state')).toBe('error');
    // Should NOT have sent any batches
    expect(pendingBatches).toHaveLength(0);
  });
});
