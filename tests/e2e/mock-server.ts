import http from 'node:http';
import { pathToFileURL } from 'node:url';

const PORT = 3456;

export const NAV_E2E_PAGE_A_PATH = '/e2e/navigation/page-a';
export const NAV_E2E_PAGE_B_PATH = '/e2e/navigation/page-b';
export const NAV_E2E_API_PREFIX = '/e2e/navigation-api';
export const NAV_E2E_PAGE_A_TEXT = 'Navigation test page A has enough English content to start translating before we navigate away.';
export const NAV_E2E_PAGE_B_TEXT = 'Navigation test page B should still translate correctly after same-tab navigation and parser fallback.';

function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function sendHtml(res: http.ServerResponse, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  setCorsHeaders(res);
  res.writeHead(200);
  res.end(html);
}

function sendJson(res: http.ServerResponse, payload: unknown) {
  res.setHeader('Content-Type', 'application/json');
  setCorsHeaders(res);
  res.writeHead(200);
  res.end(JSON.stringify(payload));
}

function createNavigationPage(title: string, body: string, linkHref?: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p id="page-text">${body}</p>
      ${linkHref ? `<a id="next-link" href="${linkHref}">Open next page</a>` : ''}
    </main>
  </body>
</html>`;
}

export function createMockServer() {
  let malformedSingleJsonOnce = true;

  return http.createServer((req, res) => {
    const requestUrl = req.url ?? '/';

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      if (requestUrl === NAV_E2E_PAGE_A_PATH) {
        sendHtml(res, createNavigationPage('Navigation Page A', NAV_E2E_PAGE_A_TEXT, NAV_E2E_PAGE_B_PATH));
        return;
      }

      if (requestUrl === NAV_E2E_PAGE_B_PATH) {
        sendHtml(res, createNavigationPage('Navigation Page B', NAV_E2E_PAGE_B_TEXT));
        return;
      }

      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const userContent = parsed.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '';
        const isNavigationApi = requestUrl.startsWith(`${NAV_E2E_API_PREFIX}/`);

        // JSON mode
        if (userContent.startsWith('{')) {
          const input = JSON.parse(userContent);
          const texts = (input.texts as string[]).map((t: string) => String(t));

          if (isNavigationApi && texts.some((t) => t.includes(NAV_E2E_PAGE_A_TEXT))) {
            setTimeout(() => {
              if (res.writableEnded || res.destroyed) return;
              sendJson(res, {
                choices: [{
                  message: {
                    content: JSON.stringify({ translations: texts.map((t) => `[翻译] ${t}`) }),
                  },
                }],
              });
            }, 1800);
            return;
          }

          if (
            isNavigationApi
            && malformedSingleJsonOnce
            && texts.length === 1
            && texts[0].includes(NAV_E2E_PAGE_B_TEXT)
          ) {
            malformedSingleJsonOnce = false;
            sendJson(res, {
              choices: [{
                message: {
                  content: texts[0],
                },
              }],
            });
            return;
          }

          sendJson(res, {
            choices: [{
              message: {
                content: JSON.stringify({ translations: texts.map((t) => `[翻译] ${t}`) }),
              },
            }],
          });
          return;
        }

        // Separator mode
        const parts = userContent.split('∥NT∥').map((s: string) => s.trim());
        const translated = parts.map((t: string) => `[翻译] ${t}`);
        sendJson(res, {
          choices: [{
            message: {
              content: translated.join('\n∥NT∥\n'),
            },
          }],
        });
      } catch {
        res.setHeader('Content-Type', 'application/json');
        setCorsHeaders(res);
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  });
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const server = createMockServer();
  server.listen(PORT, () => {
    console.log(`[Mock API] Listening on http://localhost:${PORT}`);
  });
}

export { PORT };
