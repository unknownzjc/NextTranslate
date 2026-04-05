export const CONTENT_SCRIPT_READY_KEY = '__NT_CONTENT_READY__';

const INJECTABLE_PROTOCOLS = new Set(['http:', 'https:']);

export function isInjectablePageUrl(url?: string | null): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return INJECTABLE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export async function isContentUiInjected(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (readyKey: string) => Boolean((window as unknown as Record<string, unknown>)[readyKey]),
      args: [CONTENT_SCRIPT_READY_KEY],
    });

    return Boolean(result?.result);
  } catch {
    return false;
  }
}

export async function ensureContentUiInjected(tabId: number, url?: string | null): Promise<boolean> {
  if (url !== undefined && url !== null && !isInjectablePageUrl(url)) {
    return false;
  }

  if (await isContentUiInjected(tabId)) {
    return true;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/style.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/index.js'],
    });
    return true;
  } catch {
    return false;
  }
}
