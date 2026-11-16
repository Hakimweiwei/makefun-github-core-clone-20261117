import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createGitHttpHandler } from './git-http.ts';
import { createGraphQLHandler } from './graphql.ts';
import { createMcpHandler } from './mcp.ts';
import { createRestHandler, dispatchRest } from './rest.ts';
import { ForgeStore } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new ForgeStore();
  const api = {
    request: (method: string, path: string, body?: unknown) => dispatchRest(store, method, path, body),
  };
  const handleGraphQL = createGraphQLHandler(api, { token });
  const handleMcp = createMcpHandler(api, { token });
  const handleRest = createRestHandler(store, token);
  const handleGit = createGitHttpHandler(store, token);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (await handleGraphQL(req, res)) return;
      if (await handleMcp(req, res)) return;
      if (await handleRest(req, res)) return;
      if (await handleGit(req, res)) return;

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
}
