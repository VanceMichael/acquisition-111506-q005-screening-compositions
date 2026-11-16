
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory, sourceBaseUrl: source.url });
try {
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  console.log(`${product}：人工收件与原始依据回查`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());
  const body = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  for (const label of ['首次提交', '同件再次提交']) {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify(body) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate, identity: receipt.identity }));
    const evidence = await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer();
    if (!Buffer.from(evidence).equals(fixture)) throw new Error('原始依据不一致');
  }
  console.log('当前人工收件', await (await fetch(`${application.url}/api/records`)).text());

  console.log('\n--- 按选定组合领取 IMF 资料 ---');
  // 选基础包 + 补充包，领取配音版 CPL：画面来自基础包，语言轨来自补充包
  const claimBody = { packageIds: ['base', 'supplement'], cplId: 'cpl-localized' };
  const claimResponse = await fetch(`${application.url}/api/claims`, { method: 'POST', body: JSON.stringify(claimBody) });
  const claim = await claimResponse.json();
  if (!claimResponse.ok) throw new Error(JSON.stringify(claim));
  console.log('领取单', JSON.stringify({
    status: claimResponse.status,
    identity: claim.identity,
    compositionId: claim.claim.compositionId,
    baseCpl: claim.claim.baseCpl,
    threeStates: claim.claim.status,
  }, null, 2));
  console.log('收件清单（含跨包来源与截取区间）');
  for (const asset of claim.claim.assets) {
    console.log(' ', JSON.stringify({
      assetId: asset.assetId,
      resolution: asset.resolution,
      origins: asset.origins.map(o => `${o.packageId}(AssetMap=${o.inAssetMap},PKL=${o.inPkl})`),
      bytesComplete: asset.bytesComplete,
      digestsVerified: asset.digestsVerified,
    }));
  }
  console.log('统一组合时间线');
  for (const segment of claim.claim.timeline) {
    console.log(' ', JSON.stringify({
      track: segment.trackFileId,
      editRate: segment.editRate,
      window: `[${segment.entryPoint}, ${segment.entryPoint + segment.sourceDuration})`,
      repeat: segment.repeatCount,
      seconds: segment.segmentSeconds,
      interval: segment.interval && `${segment.interval.startSeconds} -> ${segment.interval.endSeconds}`,
    }));
  }
  console.log('资源复用汇总', JSON.stringify(claim.claim.trackUsage.map(u => ({
    trackFileId: u.trackFileId, reuseCount: u.reuseCount, editRates: u.editRates,
  }))));

  // 反例：只选补充包，画面轨道在基础包，应出单但标记不足，且不拿 same-named 补位
  const insufficient = await fetch(`${application.url}/api/claims`, {
    method: 'POST',
    body: JSON.stringify({ packageIds: ['supplement'], cplId: 'cpl-localized' }),
  });
  const badClaim = await insufficient.json();
  console.log('来源不足的组合', JSON.stringify({
    status: insufficient.status,
    sufficient: badClaim.claim.status.sufficientForComposition,
    problems: badClaim.claim.issues.map(i => i.kind),
    pickedSameNamed: badClaim.claim.assets.some(a => a.assetId === 'same-named'),
  }));

  // 同件幂等
  const repeat = await fetch(`${application.url}/api/claims`, { method: 'POST', body: JSON.stringify(claimBody) });
  console.log('同件再次领取', JSON.stringify({ status: repeat.status, duplicate: (await repeat.json()).duplicate }));
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
