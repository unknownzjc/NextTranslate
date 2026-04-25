import { beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

type TabsUpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => void;
type WebNavigationCommittedListener = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void;

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

describe('background content UI injection', () => {
  let tabsUpdatedListener!: TabsUpdatedListener;
  let webNavigationCommittedListener!: WebNavigationCommittedListener;
  let ensureContentUiInjected!: ReturnType<typeof vi.fn>;
  let isAutoTranslateEnabledForUrl!: ReturnType<typeof vi.fn>;
  let tabsSendMessage!: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();

    ensureContentUiInjected = vi.fn(async () => true);
    isAutoTranslateEnabledForUrl = vi.fn(async () => false);
    tabsSendMessage = vi.fn(async () => undefined);

    vi.doMock('@shared/storage', () => ({
      loadProviderConfig: vi.fn(async () => ({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        targetLanguage: 'Simplified Chinese',
        jsonMode: 'auto',
      })),
      saveProviderConfig: vi.fn(async () => undefined),
      isAutoTranslateEnabledForUrl,
    }));

    vi.doMock('@shared/prompt', () => ({
      buildTranslateRequest: vi.fn(() => ({ messages: [] })),
      parseJsonModeResponse: vi.fn(() => null),
      parseSeparatorModeResponse: vi.fn(() => null),
    }));

    vi.doMock('@shared/content-ui', () => ({
      ensureContentUiInjected,
    }));

    vi.stubGlobal('fetch', vi.fn());

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn(),
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
        sendMessage: tabsSendMessage,
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
      webNavigation: {
        onCommitted: {
          addListener: vi.fn((listener: WebNavigationCommittedListener) => {
            webNavigationCommittedListener = listener;
          }),
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

  it('tab complete 时即使未开启总是翻译，也会注入悬浮球 UI', async () => {
    await import('../../src/background/index');

    tabsUpdatedListener(7, { status: 'complete' }, { id: 7, url: 'https://example.com/article' } as chrome.tabs.Tab);
    await flushPromises();

    expect(ensureContentUiInjected).toHaveBeenCalledWith(7, 'https://example.com/article');
    expect(isAutoTranslateEnabledForUrl).toHaveBeenCalledWith('https://example.com/article');
  });

  it('history 前进/回退完成加载时不会触发站点自动翻译', async () => {
    isAutoTranslateEnabledForUrl.mockResolvedValue(true);
    await import('../../src/background/index');

    webNavigationCommittedListener({
      documentId: 'doc-previous',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      processId: 1,
      timeStamp: Date.now(),
      url: 'https://example.com/previous',
      transitionType: 'link',
      transitionQualifiers: ['forward_back'],
    });

    tabsUpdatedListener(7, { status: 'complete' }, { id: 7, url: 'https://example.com/previous' } as chrome.tabs.Tab);
    await flushPromises();

    expect(ensureContentUiInjected).toHaveBeenCalledWith(7, 'https://example.com/previous');
    expect(isAutoTranslateEnabledForUrl).not.toHaveBeenCalled();
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('普通加载完成且站点开启自动翻译时会发送 auto 启动消息', async () => {
    isAutoTranslateEnabledForUrl.mockResolvedValue(true);
    await import('../../src/background/index');

    webNavigationCommittedListener({
      documentId: 'doc-article',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      processId: 1,
      timeStamp: Date.now(),
      url: 'https://example.com/article',
      transitionType: 'link',
      transitionQualifiers: [],
    });

    tabsUpdatedListener(7, { status: 'complete' }, { id: 7, url: 'https://example.com/article' } as chrome.tabs.Tab);
    await flushPromises();

    expect(isAutoTranslateEnabledForUrl).toHaveBeenCalledWith('https://example.com/article');
    expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: 'START_TRANSLATE_IF_IDLE', reason: 'auto' });
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

describe('background batch failure status isolation', () => {
  let runtimeMessageListener!: RuntimeMessageListener;
  let runtimeSendMessage!: ReturnType<typeof vi.fn>;

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

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('upstream failed');
    }));

    runtimeSendMessage = vi.fn(() => Promise.resolve());

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            runtimeMessageListener = listener;
          }),
        },
        onStartup: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        sendMessage: runtimeSendMessage,
      },
      action: {
        setBadgeText: vi.fn(() => Promise.resolve()),
        setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
      },
      alarms: {
        create: vi.fn(),
        clear: vi.fn(),
        onAlarm: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn(async () => []),
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://example.com/page' })),
        sendMessage: vi.fn(async () => undefined),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
      },
      contextMenus: {
        create: vi.fn(),
        onClicked: { addListener: vi.fn() },
      },
      commands: {
        onCommand: { addListener: vi.fn() },
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
  });

  it('单批次最终失败只回给 content，不广播 tab 级 error', async () => {
    await import('../../src/background/index');

    const sendResponse = vi.fn();
    const sender = { tab: { id: 1 } } as chrome.runtime.MessageSender;
    const result = runtimeMessageListener({
      type: 'TRANSLATE_BATCH',
      batchId: 'batch-error',
      texts: ['Hello from failing batch'],
      totalBatches: 1,
    }, sender, sendResponse);

    expect(result).toBe(true);

    await vi.runAllTimersAsync();
    await flushPromises(20);

    expect(sendResponse).toHaveBeenCalledWith({
      batchId: 'batch-error',
      translations: [],
      error: 'upstream failed',
    });
    expect(runtimeSendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRANSLATE_STATUS',
      status: 'error',
    }));

    const queryResponse = vi.fn();
    runtimeMessageListener({ type: 'QUERY_STATUS', tabId: 1 }, sender, queryResponse);
    expect(queryResponse).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRANSLATE_STATUS',
      status: 'translating',
    }));
  });
});
