/**
 * 零依赖静态服务器（探测页用）。
 *
 * **为什么把仓库根当文档根**：这样浏览器里的模块 URL 与 Node 里的相对路径**完全一致**——
 * `src/browser/probe.mjs` 仍然 `import '../view-model.mjs'`，而 `view-model.mjs` 仍然
 * `import '../../../packages/engine/dist/index.js'`。零改写、零打包器，两侧跑的是**同一批文件**。
 *
 * 安全边界（本地探针，仍然按最小权限写）：
 * - 只绑定 `127.0.0.1`、端口 `0`（由内核分配临时端口）；
 * - 只放行**白名单前缀**（spike 目录与引擎 dist），其余一律 403；
 * - 路径先 `resolve` 再比对前缀，杜绝 `..` 穿越。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

/**
 * @param {{ root: string, prefixes: readonly string[] }} options
 * @returns {Promise<{ port: number, origin: string, close: () => Promise<void> }>}
 */
export async function startStaticServer({ root, prefixes }) {
  const allowed = prefixes.map((prefix) => resolve(root, prefix));

  const server = createServer(
    (
      /** @type {import('node:http').IncomingMessage} */ request,
      /** @type {import('node:http').ServerResponse} */ response,
    ) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const filePath = resolve(join(root, relative));
    const permitted = allowed.some((prefix) => filePath === prefix || filePath.startsWith(prefix + sep));
    if (!permitted) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('403：路径不在白名单内\n');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('404\n');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  });

  await new Promise((settle) => {
    server.listen(0, '127.0.0.1', () => settle(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((settle) => {
        server.close(() => settle());
      }),
  };
}
