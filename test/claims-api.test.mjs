import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { openStore, digest } from '../src/store.mjs';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'claim-api-'));
  const source = await startProvider();
  const application = await startApplication({ directory, sourceBaseUrl: source.url });
  return { directory, source, application };
}

async function teardown({ directory, source, application }) {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}

test('完整流程：领取组合、幂等重提、列表/历史/单条回查、证据字节可核对', async () => {
  const ctx = await setup();
  try {
    const claimBody = { packageIds: ['base', 'supplement'], cplId: 'cpl-localized' };
    const first = await fetch(`${ctx.application.url}/api/claims`, { method: 'POST', body: JSON.stringify(claimBody) });
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.equal(receipt.key, 'cpl-localized');
    assert.deepEqual(receipt.claim.status, { bytesComplete: true, digestsVerified: true, sufficientForComposition: true });
    // 跨包来源保留
    const picture = receipt.claim.assets.find(a => a.assetId === 'main-picture');
    assert.deepEqual(picture.origins.map(o => o.packageId), ['base']);
    const language = receipt.claim.assets.find(a => a.assetId === 'new-language');
    assert.deepEqual(language.origins.map(o => o.packageId), ['supplement']);

    // 同件幂等
    const again = await fetch(`${ctx.application.url}/api/claims`, { method: 'POST', body: JSON.stringify(claimBody) });
    assert.equal(again.status, 200);
    const duplicate = await again.json();
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.identity, receipt.identity);

    // 列表与单条回查
    const list = await (await fetch(`${ctx.application.url}/api/claims`)).json();
    assert.equal(list.length, 1);
    const one = await (await fetch(`${ctx.application.url}/api/claims/${encodeURIComponent(receipt.identity)}`)).json();
    assert.equal(one.identity, receipt.identity);
    const history = await (await fetch(`${ctx.application.url}/api/claims/history?key=cpl-localized`)).json();
    assert.equal(history.length, 1);

    // 依据字节按 sha256 内容寻址回查，且与声明摘要一致
    assert.ok(receipt.evidence.length > 0);
    const chunkRef = receipt.evidence.find(ref => ref.source.startsWith('chunk:'));
    const bytes = Buffer.from(await (await fetch(`${ctx.application.url}/api/evidence/${chunkRef.sha256}`)).arrayBuffer());
    assert.equal(digest(bytes), chunkRef.sha256);
    assert.equal(bytes.length, chunkRef.size);
  } finally { await teardown(ctx); }
});

test('不足组合照常出单并保留问题：只选补充包时画面轨道缺失，不补同名对象', async () => {
  const ctx = await setup();
  try {
    const response = await fetch(`${ctx.application.url}/api/claims`, {
      method: 'POST',
      body: JSON.stringify({ packageIds: ['supplement'], cplId: 'cpl-localized' }),
    });
    assert.equal(response.status, 201); // 是可核对的收件结果，不是 5xx
    const receipt = await response.json();
    assert.equal(receipt.claim.status.sufficientForComposition, false);
    assert.equal(receipt.claim.status.bytesComplete, false);
    assert.ok(receipt.claim.issues.some(i => i.kind === 'missing-reference' && i.assetId === 'main-picture'));
    assert.ok(!receipt.claim.assets.some(a => a.assetId === 'same-named'));
  } finally { await teardown(ctx); }
});

test('请求与来源错误边界：坏请求 422，来源不可达 502 且不污染存储', async () => {
  const deadDirectory = await mkdtemp(join(tmpdir(), 'dead-'));
  const ctx = await setup();
  try {
    const bad = await fetch(`${ctx.application.url}/api/claims`, { method: 'POST', body: JSON.stringify({ packageIds: ['base'] }) });
    assert.equal(bad.status, 422);
    // 指向一个没有监听的来源端口，模拟来源不可达
    const unreachable = await startApplication({ directory: deadDirectory, sourceBaseUrl: 'http://127.0.0.1:9' });
    try {
      const failed = await fetch(`${unreachable.url}/api/claims`, {
        method: 'POST',
        body: JSON.stringify({ packageIds: ['base'], cplId: 'cpl-localized' }),
      });
      assert.equal(failed.status, 502);
      const body = await failed.json();
      assert.match(body.error, /来源不可达/);
    } finally {
      await unreachable.close();
    }
    // 失败没有写入领取单
    const list = await (await fetch(`${ctx.application.url}/api/claims`)).json();
    assert.equal(list.length, 0);
  } finally {
    await teardown(ctx);
    await rm(deadDirectory, { recursive: true, force: true });
  }
});

test('领取单与依据在重开存储后保持，人工收件与自动领取分账', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claim-persist-'));
  const source = await startProvider();
  const application = await startApplication({ directory, sourceBaseUrl: source.url });
  let identity;
  let evidenceSha;
  try {
    const response = await fetch(`${application.url}/api/claims`, {
      method: 'POST',
      body: JSON.stringify({ packageIds: ['base', 'supplement'], cplId: 'cpl-localized' }),
    });
    const receipt = await response.json();
    identity = receipt.identity;
    evidenceSha = receipt.evidence[0].sha256;
  } finally {
    await application.close();
    await source.close();
  }
  try {
    const reopened = await openStore(directory);
    const claims = reopened.listClaims();
    assert.equal(claims.length, 1);
    assert.equal(claims[0].identity, identity);
    assert.equal(reopened.claim(identity).claim.compositionId, 'cpl-localized');
    assert.equal(reopened.list().length, 0); // 人工收件账仍为空，两账分离
    const bytes = await reopened.evidence(evidenceSha);
    assert.equal(digest(bytes), evidenceSha);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
