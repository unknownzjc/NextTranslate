import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type HTTPRequest, type Page, type Target } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer } from './mock-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'dist');

const X_ARTICLE_FIXTURE_URL = 'https://x.com/koylanai/status/2025286163641118915';

const X_ARTICLE_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>X Article Fixture</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #ffffff;
        color: #111827;
      }

      [data-testid="primaryColumn"] {
        max-width: 720px;
        margin: 0 auto;
        padding: 24px 20px 80px;
      }

      [data-testid="twitter-article-title"] {
        font-size: 40px;
        line-height: 1.15;
        font-weight: 700;
        margin-bottom: 24px;
      }

      .longform-unstyled,
      .longform-header-two {
        margin-bottom: 20px;
      }

      .public-DraftStyleDefault-block {
        color: #4b5563;
      }
    </style>
  </head>
  <body>
    <main data-testid="primaryColumn">
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">The File System Is the New Database: How I Built a Personal OS for AI Agents</div>
        <div data-testid="twitterArticleRichTextView">
          <div class="css-175oi2r r-37j5jr">
            <div class="DraftEditor-root">
              <div class="DraftEditor-editorContainer">
                <div
                  aria-describedby="placeholder-fixture"
                  class="public-DraftEditor-content"
                  contenteditable="false"
                  data-testid="longformRichTextComponent"
                  spellcheck="false"
                  style="outline:none; user-select:text; white-space:pre-wrap; overflow-wrap:break-word;"
                >
                  <div>
                    <div class="longform-unstyled">
                      <div class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">
                        <span>Every AI conversation starts the same way. You explain who you are, what you're building, and what the assistant should remember before any useful work can begin.</span>
                      </div>
                    </div>
                    <h2 class="longform-header-two">1) THE CORE PROBLEM: CONTEXT, NOT PROMPTS</h2>
                    <div class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">
                      <span>1) THE CORE PROBLEM: CONTEXT, NOT PROMPTS</span>
                    </div>
                    <div class="longform-unstyled">
                      <div class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">
                        <span>Instead of repeating the same setup in every session, the system moves stable context into files so the assistant can load the right memory at the right time.</span>
                      </div>
                    </div>
                    <div class="longform-unstyled">
                      <div class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">
                        <span>That keeps the article body translatable while preventing duplicate DraftJS mirror nodes from rendering extra translated copies of the same paragraph.</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;

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

async function respondWithFixture(request: HTTPRequest) {
  if (request.isNavigationRequest() && request.resourceType() === 'document' && request.url() === X_ARTICLE_FIXTURE_URL) {
    await request.respond({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: X_ARTICLE_FIXTURE_HTML,
    });
    return;
  }

  if (request.url().startsWith('https://x.com/')) {
    await request.respond({ status: 204, body: '' });
    return;
  }

  await request.continue();
}

async function openInterceptedXArticlePage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    void respondWithFixture(request);
  });
  await page.goto(X_ARTICLE_FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.bringToFront();
  return page;
}

describe.sequential('X Article e2e', () => {
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

  it('translates X Article title and body blocks without duplicating DraftJS mirror blocks', async () => {
    const page = await openInterceptedXArticlePage();

    await page.waitForSelector('[data-testid="twitter-article-title"]', { timeout: 120000 });
    const response = await triggerTranslateForUrl(page.url());
    expect(response).toEqual({ action: 'started' });

    await page.waitForFunction(() => {
      const titleTranslation = document.querySelector('[data-testid="twitter-article-title"] > .nt-translation');
      const firstBodyTranslation = document.querySelector('[data-testid="twitterArticleRichTextView"] .longform-unstyled > .nt-translation');
      const headingTranslation = document.querySelector('[data-testid="twitterArticleRichTextView"] .longform-header-two > .nt-translation');
      const fabState = document.querySelector('.nt-fab-wrap')?.getAttribute('data-state');
      return (titleTranslation?.textContent?.includes('[翻译]') ?? false)
        && (firstBodyTranslation?.textContent?.includes('[翻译]') ?? false)
        && (headingTranslation?.textContent?.includes('[翻译]') ?? false)
        && fabState === 'translated-visible';
    }, { timeout: 120000 });

    const state = await page.evaluate(() => {
      const titleTranslation = document.querySelector('[data-testid="twitter-article-title"] > .nt-translation')?.textContent?.trim() ?? null;
      const bodyTranslations = Array.from(document.querySelectorAll('[data-testid="twitterArticleRichTextView"] .longform-unstyled > .nt-translation'))
        .map((el) => el.textContent?.trim() ?? '');
      const headingTranslation = document.querySelector('[data-testid="twitterArticleRichTextView"] .longform-header-two > .nt-translation')?.textContent?.trim() ?? null;
      const mirroredBlockTranslations = document.querySelectorAll('[data-testid="twitterArticleRichTextView"] .public-DraftStyleDefault-block > .nt-translation').length;
      const fabState = document.querySelector('.nt-fab-wrap')?.getAttribute('data-state') ?? null;

      return {
        titleTranslation,
        bodyTranslations,
        headingTranslation,
        mirroredBlockTranslations,
        fabState,
      };
    });

    expect(state.titleTranslation).toBe('[翻译] The File System Is the New Database: How I Built a Personal OS for AI Agents');
    expect(state.bodyTranslations).toEqual([
      "[翻译] Every AI conversation starts the same way. You explain who you are, what you're building, and what the assistant should remember before any useful work can begin.",
      '[翻译] Instead of repeating the same setup in every session, the system moves stable context into files so the assistant can load the right memory at the right time.',
      '[翻译] That keeps the article body translatable while preventing duplicate DraftJS mirror nodes from rendering extra translated copies of the same paragraph.',
    ]);
    expect(state.headingTranslation).toBe('[翻译] 1) THE CORE PROBLEM: CONTEXT, NOT PROMPTS');
    expect(state.mirroredBlockTranslations).toBe(0);
    expect(state.fabState).toBe('translated-visible');

    await page.close();
  });
});
