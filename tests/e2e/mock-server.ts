import http from 'node:http';
import { pathToFileURL } from 'node:url';

const PORT = 3456;

export function createMockServer() {
  return http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.writeHead(200);
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
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');

      try {
        const parsed = JSON.parse(body);
        const userContent = parsed.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '';

        let translations: string[];

        // JSON mode
        if (userContent.startsWith('{')) {
          const input = JSON.parse(userContent);
          translations = (input.texts as string[]).map((t: string) => `[翻译] ${t}`);
          res.writeHead(200);
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({ translations }),
              },
            }],
          }));
        } else {
          // Separator mode
          const parts = userContent.split('∥NT∥').map((s: string) => s.trim());
          const translated = parts.map((t: string) => `[翻译] ${t}`);
          res.writeHead(200);
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: translated.join('\n∥NT∥\n'),
              },
            }],
          }));
        }
      } catch {
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
