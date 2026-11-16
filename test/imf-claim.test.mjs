import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { claimComposition, validateSegment } from '../src/imf-claim.mjs';
import { SourceError } from '../src/source-client.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

// 内存假来源：实现来源契约要求的三个入口，供领域层测试，不依赖网络。
// packages: { packageId: { ASSETMAP, PKL, CPL } }
// objects:  { objectId: object }，object.chunks 为分块 id 列表
// chunks:   { chunkId: Buffer }，etag 按契约取分块字节的 sha256
function fakeClient({ packages, objects, chunks, missingObjects = new Set(), missingChunks = new Set(), tamperChunks = new Set() }) {
  const calls = [];
  return {
    calls,
    async fetchPackage(packageId) {
      calls.push(['package', packageId]);
      const manifest = packages[packageId];
      if (!manifest) throw new SourceError(`找不到包 ${packageId}`, { kind: 'missing', id: packageId });
      return structuredClone(manifest);
    },
    async fetchObject(objectId) {
      calls.push(['object', objectId]);
      if (missingObjects.has(objectId) || !objects[objectId]) {
        throw new SourceError(`对象缺失 ${objectId}`, { kind: 'missing', status: 404, id: objectId });
      }
      return structuredClone(objects[objectId]);
    },
    async fetchChunk(chunkId) {
      calls.push(['chunk', chunkId]);
      if (missingChunks.has(chunkId) || !chunks[chunkId]) {
        throw new SourceError(`分块缺失 ${chunkId}`, { kind: 'missing', status: 404, id: chunkId });
      }
      const bytes = Buffer.from(chunks[chunkId]);
      const etag = tamperChunks.has(chunkId) ? sha(Buffer.concat([bytes, Buffer.from('x')])) : sha(bytes);
      return { bytes, etag };
    },
  };
}

// 构造一套跨基础包/补充包的 IMF 风格夹具
function buildScenario(overrides = {}) {
  const picture = Buffer.from('picture-frames');
  const sound = Buffer.from('sound-samples');
  const language = Buffer.from('language-track');
  const chunks = { 'picture-0': picture, 'sound-0': sound, 'lang-0': language };
  const objects = {
    'main-picture': { id: 'main-picture', type: 'TrackFile', hash: 'sha256:picture-v1', chunks: ['picture-0'] },
    'main-sound': { id: 'main-sound', type: 'TrackFile', hash: 'sha256:sound-v1', chunks: ['sound-0'] },
    'new-language': { id: 'new-language', type: 'TrackFile', hash: 'sha256:language-v2', chunks: ['lang-0'] },
    'cpl-base': {
      id: 'cpl-base', type: 'CPL', issuer: 'studio-a',
      resources: [
        { trackFileId: 'main-picture', editRate: [24000, 1001], entryPoint: 0, sourceDuration: 24000, repeatCount: 1, intrinsicDuration: 48000 },
        { trackFileId: 'main-sound', editRate: [24, 1], entryPoint: 24, sourceDuration: 24, repeatCount: 1, intrinsicDuration: 240 },
      ],
    },
    'cpl-localized': {
      id: 'cpl-localized', type: 'CPL', base: 'cpl-base', issuer: 'studio-b',
      resources: [
        { trackFileId: 'main-picture', editRate: [24000, 1001], entryPoint: 100, sourceDuration: 12000, repeatCount: 1, intrinsicDuration: 48000 },
        { trackFileId: 'new-language', editRate: [24, 1], entryPoint: 0, sourceDuration: 24, repeatCount: 2, intrinsicDuration: 1000 },
      ],
    },
    'same-named': { id: 'same-named', type: 'TrackFile', hash: 'sha256:different-object' },
  };
  const packages = {
    base: { ASSETMAP: ['cpl-base', 'main-picture', 'main-sound'], PKL: ['cpl-base', 'main-picture', 'main-sound'], CPL: ['cpl-base'] },
    supplement: { ASSETMAP: ['cpl-localized', 'new-language'], PKL: ['cpl-localized', 'new-language'], CPL: ['cpl-localized'] },
  };
  return fakeClient({ packages, objects, chunks, ...overrides });
}

test('完整领取：跨包找齐资源、保留来源、三状态成立、依据留字节', async () => {
  const client = buildScenario();
  const result = await claimComposition({ client, packageIds: ['base', 'supplement'], cplId: 'cpl-localized' });

  assert.equal(result.compositionId, 'cpl-localized');
  assert.equal(result.baseCpl, 'cpl-base');
  assert.deepEqual(result.selectedPackages, ['base', 'supplement']);

  const picture = result.assets.find(a => a.assetId === 'main-picture');
  const language = result.assets.find(a => a.assetId === 'new-language');
  assert.equal(picture.resolution, 'resolved');
  // 画面来自基础包，配音来自补充包：来源都被保留
  assert.deepEqual(picture.origins.map(o => o.packageId), ['base']);
  assert.deepEqual(language.origins.map(o => o.packageId), ['supplement']);
  assert.equal(picture.declaredPklHashes[0].hash, 'sha256:picture-v1');
  assert.ok(picture.bytesComplete && picture.digestsVerified);
  assert.equal(language.chunkChecks[0].digestMatch, true);

  assert.deepEqual(result.status, { bytesComplete: true, digestsVerified: true, sufficientForComposition: true });
  assert.equal(result.issues.length, 0);

  // 依据包含 CPL、TrackFile 对象、分块与包清单，且都带原始字节
  const roles = result.evidence.map(e => e.role).sort();
  assert.ok(roles.includes('CPL'));
  assert.ok(roles.includes('TrackFile'));
  assert.ok(roles.includes('package-manifest'));
  assert.ok(result.evidence.every(e => Buffer.isBuffer(e.bytes) && e.sha256 === sha(e.bytes)));
  // 两个 CPL（含 base）都留档
  assert.equal(result.cplDocuments.filter(d => d.role === 'CPL' || d.role === 'selected' || d.role === 'base').length, 2);
});

test('组合时间线：不同编辑率、截取区间、重复数与复用在同一时间线上说清', async () => {
  const client = buildScenario();
  const result = await claimComposition({ client, packageIds: ['base', 'supplement'], cplId: 'cpl-localized' });

  assert.equal(result.timeline.length, 2);
  const [pictureSegment, languageSegment] = result.timeline;
  assert.equal(pictureSegment.entryPoint, 100);
  assert.equal(pictureSegment.sourceDuration, 12000);
  assert.equal(pictureSegment.segmentSeconds, 500.5); // 12000 / (24000/1001)
  assert.deepEqual(pictureSegment.interval.start, [0, 1]);
  assert.equal(languageSegment.repeatCount, 2);
  assert.equal(languageSegment.durationEditUnits, 48); // 24 * 2
  assert.equal(languageSegment.segmentSeconds, 2);
  assert.equal(languageSegment.interval.startSeconds, 500.5);
  assert.equal(languageSegment.interval.endSeconds, 502.5);
  assert.equal(result.compositionDurationSeconds, 502.5);

  // 画面被新清单截取的区间 [100, 12100) 明确写出
  const pictureUsage = result.trackUsage.find(u => u.trackFileId === 'main-picture');
  assert.deepEqual(pictureUsage.windows[0], { index: 0, entryPoint: 100, sourceDuration: 12000, endExclusive: 12100, repeatCount: 1 });
  assert.deepEqual(pictureUsage.editRates, ['24000/1001']);
});

test('同一资源在多段复用会汇总复用次数与不同编辑率', async () => {
  const chunks = { c: Buffer.from('shared-bytes') };
  const objects = {
    shared: { id: 'shared', type: 'TrackFile', hash: 'sha256:shared', chunks: ['c'] },
    cpl: {
      id: 'cpl', type: 'CPL',
      resources: [
        { trackFileId: 'shared', editRate: [24, 1], entryPoint: 0, sourceDuration: 12, repeatCount: 1, intrinsicDuration: 100 },
        { trackFileId: 'shared', editRate: [48, 1], entryPoint: 50, sourceDuration: 24, repeatCount: 1, intrinsicDuration: 100 },
      ],
    },
  };
  const packages = { p: { ASSETMAP: ['shared', 'cpl'], PKL: ['shared', 'cpl'], CPL: ['cpl'] } };
  const client = fakeClient({ packages, objects, chunks });
  const result = await claimComposition({ client, packageIds: ['p'], cplId: 'cpl' });

  const usage = result.trackUsage.find(u => u.trackFileId === 'shared');
  assert.equal(usage.reuseCount, 2);
  assert.deepEqual(usage.segmentIndexes, [0, 1]);
  assert.deepEqual(usage.editRates, ['24/1', '48/1']);
  assert.equal(usage.windows[1].endExclusive, 74);
  // 只领取一次实际资产，但分块依据不重复
  assert.equal(result.assets.filter(a => a.assetId === 'shared').length, 1);
  assert.equal(result.evidence.filter(e => e.source === 'chunk:c').length, 1);
  assert.equal(result.compositionDurationSeconds, 1); // 12/24 + 24/48
});

test('缺失引用：CPL 用到的轨道不在选定包，不拿同名对象补位', async () => {
  const client = buildScenario();
  // 只选补充包：画面 main-picture 在基础包，补充包没有；same-named 是陷阱对象
  const result = await claimComposition({ client, packageIds: ['supplement'], cplId: 'cpl-localized' });

  const picture = result.assets.find(a => a.assetId === 'main-picture');
  assert.equal(picture.resolution, 'unresolved');
  assert.ok(result.issues.some(i => i.kind === 'missing-reference' && i.assetId === 'main-picture'));
  assert.equal(result.status.bytesComplete, false);
  assert.equal(result.status.sufficientForComposition, false);
  // 校验状态与字节状态独立：语言轨本身字节齐且校验通过
  assert.equal(result.status.digestsVerified, false); // 整体因缺失不成立
  const language = result.assets.find(a => a.assetId === 'new-language');
  assert.equal(language.digestsVerified, true);
  // 没有任何途径把 same-named 当 main-picture
  assert.ok(!result.assets.some(a => a.assetId === 'same-named'));
});

test('身份歧义：回包对象身份与请求 UUID 不符时拒绝采用，不按名字补位', async () => {
  // 来源对 track 的回包 id 与请求 UUID 不一致（同名不同身份对象被错挂）
  const chunks = { c: Buffer.from('c') };
  const objects = {
    cpl: { id: 'cpl', type: 'CPL', resources: [{ trackFileId: 'track', editRate: [24, 1], entryPoint: 0, sourceDuration: 1, repeatCount: 1, intrinsicDuration: 10 }] },
    'same-named': { id: 'same-named', type: 'TrackFile', hash: 'sha256:different-object', chunks: ['c'] },
  };
  const client = fakeClient({
    packages: { A: { ASSETMAP: ['track', 'cpl'], PKL: ['track', 'cpl'], CPL: ['cpl'] } },
    objects,
    chunks,
  });
  client.fetchObject = async id => {
    if (id === 'track') return structuredClone(objects['same-named']); // 回包 id 是 same-named
    return structuredClone(objects[id]);
  };
  const result = await claimComposition({ client, packageIds: ['A'], cplId: 'cpl' });
  const track = result.assets.find(a => a.assetId === 'track');
  assert.equal(track.resolution, 'unresolved');
  assert.ok(result.issues.some(i => i.kind === 'identity-mismatch' && i.assetId === 'track'));
  assert.equal(result.status.sufficientForComposition, false);
});

test('PKL 声明的对象在来源取不到：记 object-missing 且不自动补同名对象', async () => {
  const client = buildScenario({ missingObjects: new Set(['main-picture']) });
  const result = await claimComposition({ client, packageIds: ['base', 'supplement'], cplId: 'cpl-localized' });
  const picture = result.assets.find(a => a.assetId === 'main-picture');
  assert.equal(picture.resolution, 'unresolved');
  assert.ok(result.issues.some(i => i.kind === 'object-missing' && i.assetId === 'main-picture'));
  assert.ok(!result.assets.some(a => a.assetId === 'same-named'));
  assert.equal(result.status.sufficientForComposition, false);
});

test('分块缺失：字节已齐不成立，且不能仅凭部分分块宣布校验通过', async () => {
  const client = buildScenario({ missingChunks: new Set(['picture-0']) });
  const result = await claimComposition({ client, packageIds: ['base', 'supplement'], cplId: 'cpl-localized' });
  const picture = result.assets.find(a => a.assetId === 'main-picture');
  assert.equal(picture.bytesComplete, false);
  assert.equal(picture.digestsVerified, false);
  assert.equal(picture.chunkChecks[0].present, false);
  assert.deepEqual(result.status, { bytesComplete: false, digestsVerified: false, sufficientForComposition: false });
  assert.ok(result.issues.some(i => i.kind === 'chunk-missing'));
});

test('分块被篡改：字节齐但校验失败，两种状态分开', async () => {
  const client = buildScenario({ tamperChunks: new Set(['lang-0']) });
  const result = await claimComposition({ client, packageIds: ['base', 'supplement'], cplId: 'cpl-localized' });
  const language = result.assets.find(a => a.assetId === 'new-language');
  assert.equal(language.bytesComplete, true);
  assert.equal(language.digestsVerified, false);
  assert.equal(result.status.bytesComplete, true);
  assert.equal(result.status.digestsVerified, false);
  assert.equal(result.status.sufficientForComposition, false);
  assert.ok(result.issues.some(i => i.kind === 'digest-mismatch'));
});

test('截取区间超出轨道固有长度会进入时间线问题并使组合不成立', () => {
  const problems = validateSegment(
    { trackFileId: 'x', editRate: [24, 1], entryPoint: 90, sourceDuration: 20, repeatCount: 1, intrinsicDuration: 100 },
    0,
  );
  assert.ok(problems.some(p => p.includes('超出轨道固有长度')));
  const ok = validateSegment(
    { trackFileId: 'x', editRate: [24, 1], entryPoint: 90, sourceDuration: 10, repeatCount: 1, intrinsicDuration: 100 },
    0,
  );
  assert.equal(ok.length, 0);
});

test('AssetMap 与 PKL 成员不一致被记录为清单问题', async () => {
  const chunks = { c: Buffer.from('x') };
  const objects = {
    t: { id: 't', type: 'TrackFile', hash: 'sha256:t', chunks: ['c'] },
    cpl: { id: 'cpl', type: 'CPL', resources: [{ trackFileId: 't', editRate: [24, 1], entryPoint: 0, sourceDuration: 1, repeatCount: 1, intrinsicDuration: 10 }] },
  };
  const packages = { p: { ASSETMAP: ['t', 'cpl'], PKL: ['cpl'], CPL: ['cpl'] } }; // t 不在 PKL
  const client = fakeClient({ packages, objects, chunks });
  const result = await claimComposition({ client, packageIds: ['p'], cplId: 'cpl' });
  assert.ok(result.issues.some(i => i.kind === 'manifest-inconsistency' && i.assetId === 't'));
});

test('目标 CPL 取不到时以 409 类错误拒绝，而不是编造领取单', async () => {
  const client = buildScenario({ missingObjects: new Set(['cpl-localized']) });
  await assert.rejects(
    claimComposition({ client, packageIds: ['base', 'supplement'], cplId: 'cpl-localized' }),
    error => error.status === 409,
  );
});

test('请求参数校验', async () => {
  const client = buildScenario();
  await assert.rejects(claimComposition({ client, packageIds: [], cplId: 'cpl' }), error => error.status === 422);
  await assert.rejects(claimComposition({ client, packageIds: ['base'], cplId: '' }), error => error.status === 422);
});
