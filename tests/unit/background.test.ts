import { beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

type TabsUpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => void;

async function flushPromises(times = 6) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('background tab state clearing', () => {
  let runtimeMessageListener!: RuntimeMessageListener;
  let tabsUpdatedListener!: TabsUpdatedListener;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();

    vi.doMock('@shared/storage', () => ({
      loadProviderConfig: vi.fn(async () => ({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'auto',
      })),
      saveProviderConfig: vi.fn(async () => undefined),
      isAutoTranslateEnabledForUrl: vi.fn(async () => false),
    }));

    vi.doMock('@shared/prompt', () => ({
      buildTranslateRequest: vi.fn(() => ({ messages: [] })),
      parseJsonModeResponse: vi.fn(() => null),
      parseSeparatorModeResponse: vi.fn(() => null),
    }));

    vi.doMock('@shared/content-ui', () => ({
      ensureContentUiInjected: vi.fn(async () => true),
    }));

    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }));

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            runtimeMessageListener = listener;
          }),
        },
        onStartup: {
          addListener: vi.fn(),
        },
        onInstalled: {
          addListener: vi.fn(),
        },
        sendMessage: vi.fn(() => Promise.resolve()),
      },
      action: {
        setBadgeText: vi.fn(() => Promise.resolve()),
        setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
      },
      alarms: {
        create: vi.fn(),
        clear: vi.fn(),
        onAlarm: {
          addListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn(async () => []),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://example.com/page' })),
        sendMessage: vi.fn(async () => undefined),
        onRemoved: {
          addListener: vi.fn(),
        },
        onUpdated: {
          addListener: vi.fn((listener: TabsUpdatedListener) => {
            tabsUpdatedListener = listener;
          }),
        },
        onActivated: {
          addListener: vi.fn(),
        },
      },
      contextMenus: {
        create: vi.fn(),
        onClicked: {
          addListener: vi.fn(),
        },
      },
      commands: {
        onCommand: {
          addListener: vi.fn(),
        },
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
  });

  it('tab loading 时会给已中断的批次返回 cancelled，避免内容脚本永久等待', async () => {
    await import('../../src/background/index');

    const sendResponse = vi.fn();
    const sender = { tab: { id: 1 } } as chrome.runtime.MessageSender;
    const result = runtimeMessageListener({
      type: 'TRANSLATE_BATCH',
      batchId: 'batch-1',
      texts: ['Hello from pending batch'],
      totalBatches: 1,
    }, sender, sendResponse);

    expect(result).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(1);

    tabsUpdatedListener(1, { status: 'loading' }, { id: 1 } as chrome.tabs.Tab);
    await flushPromises();

    expect(sendResponse).toHaveBeenCalledWith({
      batchId: 'batch-1',
      translations: [],
      cancelled: true,
    });
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });
});

describe('background json mode fallback', () => {
  let runtimeMessageListener!: RuntimeMessageListener;
  let saveProviderConfig!: ReturnType<typeof vi.fn>;
  let loadProviderConfig!: ReturnType<typeof vi.fn>;
  let parseJsonModeResponse!: ReturnType<typeof vi.fn>;
  let parseSeparatorModeResponse!: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();

    loadProviderConfig = vi.fn()
      .mockResolvedValueOnce({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'auto',
      })
      .mockResolvedValueOnce({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'disabled',
      });
    saveProviderConfig = vi.fn(async () => undefined);
    parseJsonModeResponse = vi.fn(() => null);
    parseSeparatorModeResponse = vi.fn(() => ({ translations: ['重试后的正常译文'] }));

    vi.doMock('@shared/storage', () => ({
      loadProviderConfig,
      saveProviderConfig,
      isAutoTranslateEnabledForUrl: vi.fn(async () => false),
    }));

    vi.doMock('@shared/prompt', () => ({
      buildTranslateRequest: vi.fn(() => ({ messages: [] })),
      parseJsonModeResponse,
      parseSeparatorModeResponse,
    }));

    vi.doMock('@shared/content-ui', () => ({
      ensureContentUiInjected: vi.fn(async () => true),
    }));

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: vi.fn(() => null) },
      json: async () => ({
        choices: [{ message: { content: 'Hello from provider' } }],
      }),
    })));

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            runtimeMessageListener = listener;
          }),
        },
        onStartup: {
          addListener: vi.fn(),
        },
        onInstalled: {
          addListener: vi.fn(),
        },
        sendMessage: vi.fn(() => Promise.resolve()),
      },
      action: {
        setBadgeText: vi.fn(() => Promise.resolve()),
        setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
      },
      alarms: {
        create: vi.fn(),
        clear: vi.fn(),
        onAlarm: {
          addListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn(async () => []),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://example.com/page' })),
        sendMessage: vi.fn(async () => undefined),
        onRemoved: {
          addListener: vi.fn(),
        },
        onUpdated: {
          addListener: vi.fn(),
        },
        onActivated: {
          addListener: vi.fn(),
        },
      },
      contextMenus: {
        create: vi.fn(),
        onClicked: {
          addListener: vi.fn(),
        },
      },
      commands: {
        onCommand: {
          addListener: vi.fn(),
        },
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
  });

  it('auto 模式下 JSON 解析失败会切到 separator 重试，而不是把原文当译文', async () => {
    await import('../../src/background/index');

    const sendResponse = vi.fn();
    const sender = { tab: { id: 1 } } as chrome.runtime.MessageSender;
    const result = runtimeMessageListener({
      type: 'TRANSLATE_BATCH',
      batchId: 'batch-json-fallback',
      texts: ['Hello from pending batch'],
      totalBatches: 1,
    }, sender, sendResponse);

    expect(result).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();

    expect(saveProviderConfig).toHaveBeenCalledWith({ jsonMode: 'disabled' });
    expect(parseJsonModeResponse).toHaveBeenCalledTimes(1);
    expect(parseSeparatorModeResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({
      batchId: 'batch-json-fallback',
      translations: ['重试后的正常译文'],
    });
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });
});
