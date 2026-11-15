import test from 'node:test';
import assert from 'node:assert/strict';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const cpl = await (await fetch(`${source.url}/objects/cpl-localized`)).json();
    assert.equal(cpl.resources[0].editRate[0], 24000);
    assert.equal(cpl.package, 'supplement');
    const inherited = await (await fetch(`${source.url}/objects/main-picture`)).json();
    assert.equal(inherited.package, 'base');
    const chunk = await fetch(`${source.url}/chunks/picture-0`);
    assert.equal(chunk.status, 200);
    assert.match(chunk.headers.get('etag'), /^"[a-f0-9]{64}"$/);
    assert.ok((await chunk.arrayBuffer()).byteLength > 0);
  } finally { await source.close(); }
});
