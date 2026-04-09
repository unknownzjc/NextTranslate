import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page, type Target } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMockServer,
  NAV_E2E_API_PREFIX,
  NAV_E2E_PAGE_A_PATH,
  NAV_E2E_PAGE_A_TEXT,
  NAV_E2E_PAGE_B_PATH,
  NAV_E2E_PAGE_B_TEXT,
} from './mock-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist');

const HOSTILE_FLOATING_UI_CSS = `
  span {
    top: 100% !important;
    left: 0 !important;
    transform: translateY(18px) !important;
  }

  button {
    filter: drop-shadow(0 0 18px rgba(91, 110, 245, 0.45)) !important;
    backdrop-filter: blur(12px) !important;
  }
`;


let server: Server;
let browser: Browser;
let extensionPage: Page;
let extensionId = '';
let mockPort = 0;

async function waitForExtensionTarget(): Promise<Target> {
  const existing = browser.targets().find((target) =>
    target.type() === 'service_worker' && target.url().includes('/background/index.js'));
  if (existing) return existing;

  return browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().includes('/background/index.js'),
    { timeout: 60000 },
  );
}

async function configureMockProvider(endpoint: string) {
  await extensionPage.bringToFront();
  await extensionPage.waitForSelector('#provider-preset');
  await extensionPage.select('#provider-preset', 'custom');
  await extensionPage.click('#endpoint', { clickCount: 3 });
  await extensionPage.type('#endpoint', endpoint);
  await extensionPage.click('#api-key', { clickCount: 3 });
  await extensionPage.type('#api-key', 'mock-key');
  await extensionPage.click('#model', { clickCount: 3 });
  await extensionPage.type('#model', 'mock-model');
  await extensionPage.click('#save-btn');
  await extensionPage.waitForFunction(() => {
    const result = document.querySelector('#test-result');
    return result?.textContent?.includes('设置已保存') ?? false;
  }, { timeout: 30000 });
}

async function setAutoTranslateSites(sites: Record<string, boolean>) {
  await extensionPage.evaluate(async (nextSites: Record<string, boolean>) => {
    await chrome.storage.sync.set({ 'nt:autoTranslateSites': nextSites });
  }, sites);
}

async function openPage(
  url: string,
  options: { injectHostileFloatingUiCss?: boolean } = {},
): Promise<Page> {
  const page = await browser.newPage();

  if (options.injectHostileFloatingUiCss) {
    await page.evaluateOnNewDocument((cssText: string) => {
      const style = document.createElement('style');
      style.id = 'nt-hostile-floating-ui-style';
      style.textContent = cssText;
      document.documentElement.appendChild(style);
    }, HOSTILE_FLOATING_UI_CSS);
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.bringToFront();
  return page;
}

describe.sequential('same-tab navigation regression', () => {
  beforeAll(async () => {
    server = createMockServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        mockPort = (server.address() as AddressInfo).port;
        resolve();
      });
    });

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });

    const target = await waitForExtensionTarget();
    extensionId = new URL(target.url()).host;
    extensionPage = await browser.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup/index.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  });

  afterAll(async () => {
    await extensionPage?.close().catch(() => {});
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it('same-tab 跳转后会取消旧请求，并在 hostile host 样式下保持悬浮球稳定', async () => {
    await configureMockProvider(`http://localhost:${mockPort}${NAV_E2E_API_PREFIX}`);
    await setAutoTranslateSites({ localhost: true });

    const page = await openPage(`http://localhost:${mockPort}${NAV_E2E_PAGE_A_PATH}`, {
      injectHostileFloatingUiCss: true,
    });

    await page.waitForFunction(() => {
      return document.querySelector('.nt-fab-wrap')?.getAttribute('data-state') === 'translating';
    }, { timeout: 30000 });

    await page.waitForFunction(() => {
      return document.querySelector('.nt-translation.nt-loading') !== null;
    }, { timeout: 30000 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }),
      page.click('#next-link'),
    ]);

    await page.waitForFunction(() => {
      return document.querySelector('#page-text')?.textContent?.includes('Navigation test page B') ?? false;
    }, { timeout: 30000 });

    await page.waitForFunction(() => {
      const translation = document.querySelector('#page-text .nt-translation');
      const fabState = document.querySelector('.nt-fab-wrap')?.getAttribute('data-state');
      return (translation?.textContent?.includes('[翻译]') ?? false) && fabState === 'translated-visible';
    }, { timeout: 120000 });

    const state = await page.evaluate(() => {
      const source = document.querySelector('#page-text');
      const translation = source?.querySelector('.nt-translation');
      const wrap = document.querySelector('.nt-fab-wrap') as HTMLElement | null;
      const button = document.querySelector('.nt-fab-button') as HTMLButtonElement | null;
      const badge = document.querySelector('.nt-fab-badge') as HTMLSpanElement | null;
      const fabState = wrap?.getAttribute('data-state') ?? null;
      const buttonRect = button?.getBoundingClientRect();
      const badgeRect = badge?.getBoundingClientRect();
      const wrapStyle = wrap ? getComputedStyle(wrap) : null;
      const buttonStyle = button ? getComputedStyle(button) : null;

      return {
        sourceText: source?.childNodes[0]?.textContent?.trim() ?? source?.textContent?.trim() ?? null,
        translationText: translation?.textContent?.trim() ?? null,
        fabState,
        hasLoadingPlaceholder: Boolean(document.querySelector('.nt-translation.nt-loading')),
        fabViewTransitionName: wrapStyle?.viewTransitionName ?? null,
        fabFilter: buttonStyle?.filter ?? null,
        fabBackdropFilter: buttonStyle?.backdropFilter ?? null,
        badgeTop: badgeRect?.top ?? null,
        badgeBottom: badgeRect?.bottom ?? null,
        buttonBottom: buttonRect?.bottom ?? null,
      };
    });

    expect(state.sourceText).toBe(NAV_E2E_PAGE_B_TEXT);
    expect(state.translationText).toBe(`[翻译] ${NAV_E2E_PAGE_B_TEXT}`);
    expect(state.translationText).not.toBe(state.sourceText);
    expect(state.translationText).not.toBe(`[翻译] ${NAV_E2E_PAGE_A_TEXT}`);
    expect(state.fabState).toBe('translated-visible');
    expect(state.hasLoadingPlaceholder).toBe(false);
    expect(state.fabViewTransitionName).toBe('none');
    expect(state.fabFilter).toBe('none');
    expect(state.fabBackdropFilter).toBe('none');
    expect(state.badgeTop).not.toBeNull();
    expect(state.badgeBottom).not.toBeNull();
    expect(state.buttonBottom).not.toBeNull();
    expect(state.badgeTop!).toBeLessThan(state.buttonBottom! - 2);
    expect(state.badgeBottom!).toBeGreaterThan(state.buttonBottom! - 12);

    await page.close();
    await setAutoTranslateSites({});
  });
});
