import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page, type Target } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer } from './mock-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist');

const GITHUB_PR_LIST_URL = 'https://github.com/google-gemini/gemini-cli/pulls';
const GITHUB_PR_DETAIL_URL = 'https://github.com/google-gemini/gemini-cli/pull/24706';

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

async function configureMockProvider() {
  await extensionPage.bringToFront();
  await extensionPage.waitForSelector('#provider-preset');
  await extensionPage.select('#provider-preset', 'custom');
  await extensionPage.click('#endpoint', { clickCount: 3 });
  await extensionPage.type('#endpoint', `http://localhost:${mockPort}`);
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

async function triggerTranslateForUrl(url: string) {
  return extensionPage.evaluate(async (targetUrl: string) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const tab = tabs.find((item) => item.url === targetUrl);
    if (!tab?.id) {
      throw new Error(`No tab found for ${targetUrl}`);
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    } catch {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/style.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/index.js'],
      });
      return chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    }
  }, url);
}

async function openPage(url: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.bringToFront();
  return page;
}

describe.sequential('GitHub PR real e2e', () => {
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

    await configureMockProvider();
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

  it('translates GitHub PR list titles without pushing metadata below the title line host', async () => {
    const page = await openPage(GITHUB_PR_LIST_URL);

    await page.waitForSelector('a.markdown-title[href*="/pull/"]', { timeout: 120000 });
    const response = await triggerTranslateForUrl(page.url());
    expect(response).toEqual({ action: 'started' });

    await page.waitForFunction(() => {
      const translation = document.querySelector('.nt-github-pr-title-line > .nt-translation');
      return translation?.textContent?.includes('[翻译]') ?? false;
    }, { timeout: 120000 });

    const state = await page.evaluate(() => {
      const host = document.querySelector('.nt-github-pr-title-line');
      const title = host?.querySelector('a.markdown-title[href*="/pull/"]');
      const translation = host?.querySelector(':scope > .nt-translation');
      const dots = host?.querySelector('.nt-pending-dots');
      const metadata = host?.nextElementSibling;

      return {
        hostExists: Boolean(host),
        titleExists: Boolean(title),
        translationText: translation?.textContent ?? null,
        hasDots: Boolean(dots),
        metadataTag: metadata?.tagName ?? null,
        metadataText: metadata?.textContent?.trim() ?? null,
      };
    });

    expect(state.hostExists).toBe(true);
    expect(state.titleExists).toBe(true);
    expect(state.translationText).toMatch(/^\[翻译\]/);
    expect(state.hasDots).toBe(false);
    expect(state.metadataTag).toBe('DIV');
    expect(state.metadataText).toContain('opened');

    await page.close();
  });

  it('translates GitHub PR detail title and comment bodies while skipping header metadata and tabs', async () => {
    const page = await openPage(GITHUB_PR_DETAIL_URL);

    await page.waitForSelector('h1[data-component="PH_Title"]', { timeout: 120000 });
    await page.waitForSelector('.comment-body', { timeout: 120000 });

    const response = await triggerTranslateForUrl(page.url());
    expect(response).toEqual({ action: 'started' });

    await page.waitForFunction(() => {
      const titleTranslation = document.querySelector('h1[data-component="PH_Title"] > .nt-translation');
      const commentTranslation = document.querySelector('.comment-body .nt-translation');
      return (titleTranslation?.textContent?.includes('[翻译]') ?? false)
        && (commentTranslation?.textContent?.includes('[翻译]') ?? false);
    }, { timeout: 120000 });

    const state = await page.evaluate(() => {
      const titleHost = document.querySelector('h1[data-component="PH_Title"]');
      const titleTranslation = titleHost?.querySelector(':scope > .nt-translation');
      const firstCommentBody = document.querySelector('.comment-body');
      const firstCommentTranslation = firstCommentBody?.querySelector('.nt-translation');
      const headerMetaTranslation = document.querySelector('.prc-PageHeader-Description-w-ejP .nt-translation');
      const tabsTranslation = document.querySelector('[aria-label="Pull request navigation tabs"] .nt-translation');

      return {
        titleTranslationText: titleTranslation?.textContent ?? null,
        firstCommentTranslationText: firstCommentTranslation?.textContent ?? null,
        hasHeaderMetaTranslation: Boolean(headerMetaTranslation),
        hasTabsTranslation: Boolean(tabsTranslation),
      };
    });

    expect(state.titleTranslationText).toMatch(/^\[翻译\]/);
    expect(state.firstCommentTranslationText).toMatch(/^\[翻译\]/);
    expect(state.hasHeaderMetaTranslation).toBe(false);
    expect(state.hasTabsTranslation).toBe(false);

    await page.close();
  });
});
