
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { validateRecord, product } from './domain.mjs';
import { createSourceClient } from './source-client.mjs';
import { claimComposition } from './imf-claim.mjs';

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('收件超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效JSON'), { status: 400 }); }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function startApplication({ directory, port = 0, host = '127.0.0.1', sourceBaseUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4311', createClient = createSourceClient } = {}) {
  const store = await openStore(directory);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { product, status: 'ok' });
      if (request.method === 'POST' && url.pathname === '/api/manual') {
        const input = await readJson(request);
        const { key, record } = validateRecord(input.record);
        const receipt = await store.accept(key, record, input.evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, receipt);
      }
      if (request.method === 'POST' && url.pathname === '/api/claims') {
        const input = await readJson(request);
        if (!input || !Array.isArray(input.packageIds) || typeof input.cplId !== 'string') {
          throw Object.assign(new Error('领取请求需要 packageIds 数组与 cplId'), { status: 422 });
        }
        const client = createClient(input.sourceBaseUrl ?? sourceBaseUrl);
        // 来源缺失/歧义不抛成 5xx：照常出单，把问题与三种独立状态写进领取结果
        const result = await claimComposition({ client, packageIds: input.packageIds, cplId: input.cplId });
        const { evidence, ...claim } = result;
        const receipt = await store.acceptClaim(claim, evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, receipt);
      }
      if (request.method === 'GET' && url.pathname === '/api/claims') return sendJson(response, 200, store.listClaims());
      if (request.method === 'GET' && url.pathname === '/api/claims/history') return sendJson(response, 200, store.claimHistory(url.searchParams.get('key')));
      if (request.method === 'GET' && url.pathname.startsWith('/api/claims/')) {
        const identity = decodeURIComponent(url.pathname.slice('/api/claims/'.length));
        return sendJson(response, 200, store.claim(identity));
      }
      if (request.method === 'GET' && url.pathname === '/api/records') return sendJson(response, 200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/history') return sendJson(response, 200, store.history(url.searchParams.get('key')));
      if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const bytes = await store.evidence(url.pathname.slice('/api/evidence/'.length));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(bytes);
      }
      sendJson(response, 404, { error: '入口不存在' });
    } catch (error) {
      const status = error.status ?? (error.kind === 'unreachable' ? 502 : error.kind ? 502 : error.code === 'ENOENT' ? 404 : 500);
      const safeMessage = status === 500 ? '收件服务内部错误' : error.message;
      sendJson(response, status, { error: safeMessage });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { store, server, url: `http://${host}:${server.address().port}`, async close() {
    await new Promise(resolve => server.close(resolve));
    await store.flush();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startApplication({ directory: process.env.DATA_DIR ?? './var', port: Number(process.env.PORT ?? 4310), host: process.env.HOST ?? '127.0.0.1' });
  console.log(JSON.stringify({ product, url: application.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => application.close().then(() => process.exit(0)));
}
