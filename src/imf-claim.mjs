// IMF 组合领取核心流程（纯领域逻辑，不绑定 HTTP 与存储）。
//
// 输入：选定的包标识、目标 CPL 标识，以及一个符合来源契约的客户端
// （fetchPackage / fetchObject / fetchChunk，见 source-client.mjs）。
// 输出：可核对的领取结果——收件清单、来源包、三种彼此独立的完整性状态、
// 资源使用区间与复用汇总，以及带原始字节的依据（evidence，交给存储层内容寻址）。
//
// 身份只按 Asset UUID（对象 id）连接，绝不按文件名相似补位；
// 来源有歧义或缺失时只记录问题，不替操作员选择同名对象。

import { createHash } from 'node:crypto';
import { add, from as rationalFrom, make, toDecimal } from './rational.mjs';

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

function issue(kind, message, extra = {}) {
  return { kind, message, ...extra };
}

// 阶段一：按选定包建立 Asset 目录。
// 同一 Asset UUID 在多个包出现时：
//   - PKL 声明哈希一致 => 同一资产，多个来源全部保留；
//   - PKL 声明哈希冲突 => 身份歧义，标记后不允许被组合自动选用。
async function buildCatalog(client, packageIds) {
  const assets = new Map(); // assetId -> 目录条目
  const packages = [];
  const catalogIssues = [];

  const ensureAsset = assetId => {
    if (!assets.has(assetId)) {
      assets.set(assetId, {
        assetId,
        origins: [],            // 该资产在哪些包的哪些清单里出现
        declaredHashes: [],     // 各包 PKL 声明的哈希（占位 URN 也原样保留）
        objectType: null,
        object: null,
        chunks: [],
        ambiguity: null,        // 非 null 表示身份歧义
      });
    }
    return assets.get(assetId);
  };

  for (const packageId of packageIds) {
    const manifest = await client.fetchPackage(packageId);
    const { ASSETMAP, PKL, CPL } = manifest;
    packages.push({ packageId, assetMap: [...ASSETMAP], pkl: [...PKL], cpl: [...CPL] });

    const mapSet = new Set(ASSETMAP);
    const pklSet = new Set(PKL);
    const cplSet = new Set(CPL);

    for (const assetId of new Set([...ASSETMAP, ...PKL, ...CPL])) {
      const entry = ensureAsset(assetId);
      const inMap = mapSet.has(assetId);
      const inPkl = pklSet.has(assetId);
      const inCpl = cplSet.has(assetId);
      entry.origins.push({ packageId, inAssetMap: inMap, inPkl, isCpl: inCpl });
      if (inMap !== inPkl) {
        catalogIssues.push(issue(
          'manifest-inconsistency',
          `资产 ${assetId} 在包 ${packageId} 的 AssetMap 与 PKL 中不一致（AssetMap=${inMap}，PKL=${inPkl}）`,
          { assetId, packageId, inAssetMap: inMap, inPkl },
        ));
      }
    }
  }

  // 拉取每个资产的对象描述，建立 PKL 哈希声明与 AssetMap 分块的连接
  for (const entry of assets.values()) {
    let object;
    try {
      object = await client.fetchObject(entry.assetId);
    } catch (error) {
      if (error.kind === 'missing') {
        catalogIssues.push(issue('object-missing', `AssetMap/PKL 声明的对象在来源取不到：${entry.assetId}`, { assetId: entry.assetId }));
        continue;
      }
      throw error;
    }
    if (object.id !== entry.assetId) {
      catalogIssues.push(issue('identity-mismatch', `对象身份回包不一致：请求 ${entry.assetId}，实际 ${object.id}`, { assetId: entry.assetId, returnedId: object.id }));
      continue;
    }
    entry.object = object;
    entry.objectType = object.type ?? null;
    entry.declaredHashes = entry.origins
      .filter(origin => origin.inPkl)
      .map(origin => ({ packageId: origin.packageId, hash: object.hash ?? null }));

    const distinctHashes = [...new Set(entry.declaredHashes.map(item => item.hash))];
    if (distinctHashes.length > 1) {
      entry.ambiguity = issue(
        'ambiguous-identity',
        `资产 ${entry.assetId} 在不同包的 PKL 声明哈希不一致，拒绝自动选用：${distinctHashes.join(' / ')}`,
        { assetId: entry.assetId, declarations: entry.declaredHashes },
      );
    }
    if (Array.isArray(object.chunks)) entry.chunks = [...object.chunks];
  }

  return { packages, assets, catalogIssues };
}

// 校验 CPL 单个资源段的时间字段
export function validateSegment(segment, index) {
  const problems = [];
  const where = `第 ${index + 1} 段（${segment.trackFileId ?? '未知轨道'}）`;
  if (typeof segment.trackFileId !== 'string' || !segment.trackFileId) {
    problems.push(`${where}缺少 trackFileId`);
  }
  let editRate = null;
  try {
    editRate = rationalFrom(segment.editRate, `${where} editRate`);
    if (editRate[0] <= 0) problems.push(`${where}编辑率必须为正数`);
  } catch (error) {
    problems.push(`${where}编辑率无效：${error.message}`);
  }
  for (const field of ['entryPoint', 'sourceDuration', 'repeatCount', 'intrinsicDuration']) {
    if (!Number.isInteger(segment[field]) || segment[field] < 0) problems.push(`${where}${field} 必须是非负整数`);
  }
  if (Number.isInteger(segment.repeatCount) && segment.repeatCount <= 0) {
    problems.push(`${where}repeatCount 必须为正整数`);
  }
  if (Number.isInteger(segment.entryPoint) && Number.isInteger(segment.sourceDuration) && Number.isInteger(segment.intrinsicDuration)) {
    if (segment.entryPoint + segment.sourceDuration > segment.intrinsicDuration) {
      problems.push(`${where}截取区间 [${segment.entryPoint}, ${segment.entryPoint + segment.sourceDuration}) 超出轨道固有长度 ${segment.intrinsicDuration}`);
    }
  }
  return problems;
}

// 阶段四：把 CPL 各资源段排成一条统一组合时间线（不同编辑率按有理数相加）
function buildTimeline(segments, trackAssets) {
  const timeline = [];
  const usage = new Map();
  let cursor = make(0, 1);

  segments.forEach((segment, index) => {
    const problems = validateSegment(segment, index);
    let editRate = null;
    let durationEditUnits = null;
    let interval = null;
    let segmentSeconds = null;
    try {
      editRate = rationalFrom(segment.editRate, 'editRate');
      durationEditUnits = Number.isInteger(segment.sourceDuration) && Number.isInteger(segment.repeatCount)
        ? segment.sourceDuration * segment.repeatCount
        : null;
      if (editRate && durationEditUnits !== null) {
        // 秒数 = 编辑单位数 / 编辑率 = units * (rateDenominator / rateNumerator)
        const seconds = make(durationEditUnits * editRate[1], editRate[0]);
        const next = add(cursor, seconds);
        interval = {
          start: cursor,
          end: next,
          startSeconds: toDecimal(cursor),
          endSeconds: toDecimal(next),
        };
        segmentSeconds = toDecimal(seconds);
        cursor = next;
      }
    } catch (error) {
      problems.push(`第 ${index + 1} 段时间线计算失败：${error.message}`);
    }

    timeline.push({
      index,
      trackFileId: segment.trackFileId,
      editRate: editRate ? [editRate[0], editRate[1]] : (Array.isArray(segment.editRate) ? [...segment.editRate] : null),
      entryPoint: segment.entryPoint,
      sourceDuration: segment.sourceDuration,
      repeatCount: segment.repeatCount,
      intrinsicDuration: segment.intrinsicDuration,
      durationEditUnits,
      segmentSeconds,
      interval,
      problems,
    });

    if (typeof segment.trackFileId === 'string') {
      if (!usage.has(segment.trackFileId)) {
        usage.set(segment.trackFileId, {
          trackFileId: segment.trackFileId,
          segmentIndexes: [],
          editRates: new Set(),
          windows: [],
          resolved: !!trackAssets.get(segment.trackFileId),
        });
      }
      const summary = usage.get(segment.trackFileId);
      summary.segmentIndexes.push(index);
      if (Array.isArray(segment.editRate)) summary.editRates.add(`${segment.editRate[0]}/${segment.editRate[1]}`);
      if (Number.isInteger(segment.entryPoint) && Number.isInteger(segment.sourceDuration)) {
        summary.windows.push({
          index,
          entryPoint: segment.entryPoint,
          sourceDuration: segment.sourceDuration,
          endExclusive: segment.entryPoint + segment.sourceDuration,
          repeatCount: segment.repeatCount,
        });
      }
    }
  });

  const trackUsage = [...usage.values()].map(item => ({
    ...item,
    editRates: [...item.editRates],
    reuseCount: item.segmentIndexes.length,
  }));

  return { timeline, trackUsage, compositionDuration: cursor, compositionDurationSeconds: toDecimal(cursor) };
}

// 主流程
export async function claimComposition({ client, packageIds, cplId }) {
  if (!Array.isArray(packageIds) || packageIds.length === 0 || packageIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw Object.assign(new Error('需要至少选定一个来源包'), { status: 422 });
  }
  if (typeof cplId !== 'string' || !cplId.trim()) {
    throw Object.assign(new Error('需要目标 CPL 标识'), { status: 422 });
  }
  const uniquePackages = [...new Set(packageIds)];
  const issues = [];
  const evidence = [];

  const pushEvidence = (source, mediaType, bytes, extra = {}) => {
    const sha256 = sha256Hex(bytes);
    const ref = { source, mediaType, sha256, size: bytes.length, ...extra };
    if (!evidence.some(item => item.sha256 === sha256 && item.source === source)) evidence.push({ ...ref, bytes });
    return ref;
  };

  // 阶段一：建立跨包目录
  const catalog = await buildCatalog(client, uniquePackages);
  issues.push(...catalog.catalogIssues);

  // 阶段二：领取目标 CPL，并记录其基础 CPL 关系（配音版沿用基础包画面）
  let cplObject;
  try {
    cplObject = await client.fetchObject(cplId);
  } catch (error) {
    if (error.kind === 'missing') {
      throw Object.assign(new Error(`目标 CPL 在来源取不到：${cplId}`), { status: 409, kind: 'missing', cplId });
    }
    throw error;
  }
  if (cplObject.id !== cplId) {
    throw Object.assign(new Error(`目标 CPL 身份回包不一致：请求 ${cplId}，实际 ${cplObject.id}`), { status: 409, kind: 'identity-mismatch' });
  }
  const cplBytes = Buffer.from(JSON.stringify(cplObject));
  pushEvidence(`object:${cplId}`, 'application/json', cplBytes, { role: 'CPL' });

  const cplDocuments = [{
    assetId: cplId,
    role: 'selected',
    issuer: cplObject.issuer ?? null,
    packageIds: catalog.packages.filter(pkg => pkg.cpl.includes(cplId)).map(pkg => pkg.packageId),
  }];

  let baseCplId = null;
  if (cplObject.base) {
    baseCplId = cplObject.base;
    try {
      const baseObject = await client.fetchObject(baseCplId);
      pushEvidence(`object:${baseCplId}`, 'application/json', Buffer.from(JSON.stringify(baseObject)), { role: 'CPL' });
      cplDocuments.push({
        assetId: baseCplId,
        role: 'base',
        issuer: baseObject.issuer ?? null,
        packageIds: catalog.packages.filter(pkg => pkg.cpl.includes(baseCplId)).map(pkg => pkg.packageId),
      });
    } catch (error) {
      if (error.kind === 'missing') {
        issues.push(issue('base-cpl-missing', `CPL ${cplId} 声明的基础 CPL 取不到：${baseCplId}`, { assetId: baseCplId }));
      } else {
        throw error;
      }
    }
  }

  if (!Array.isArray(cplObject.resources)) {
    throw Object.assign(new Error(`CPL ${cplId} 缺少 resources 资源段`), { status: 409, kind: 'corrupt' });
  }

  // 阶段三：按 CPL TrackFileId 解析实际资产，只认 UUID，不靠文件名
  const trackAssets = new Map();
  for (const segment of cplObject.resources) {
    const trackId = segment.trackFileId;
    if (typeof trackId !== 'string') continue;
    if (trackAssets.has(trackId)) continue;
    const entry = catalog.assets.get(trackId);
    if (!entry) {
      issues.push(issue('missing-reference', `CPL 引用的轨道不在选定包的 AssetMap/PKL 中：${trackId}`, { assetId: trackId }));
      trackAssets.set(trackId, null);
      continue;
    }
    if (entry.ambiguity) {
      issues.push(entry.ambiguity);
      trackAssets.set(trackId, null);
      continue;
    }
    // 对象取不到或回包身份不符时，目录条目不具备可用对象，按未解析处理，
    // 绝不退而选择一个同名对象补上。
    if (!entry.object) {
      if (!issues.some(item => item.assetId === trackId && ['object-missing', 'identity-mismatch'].includes(item.kind))) {
        issues.push(issue('unresolved-object', `资产 ${trackId} 没有可用的来源对象`, { assetId: trackId }));
      }
      trackAssets.set(trackId, null);
      continue;
    }
    trackAssets.set(trackId, entry);
  }

  // 阶段三b：拉取实际用到的 TrackFile 对象与全部分块，并逐块核验
  const chunkCache = new Map(); // chunkId -> { bytes, sha256, etag, match }
  const assets = [];

  for (const [trackId, entry] of trackAssets) {
    if (!entry) {
      assets.push({
        assetId: trackId,
        objectType: null,
        origins: [],
        declaredPklHashes: [],
        usedByComposition: true,
        resolution: 'unresolved',
        bytesComplete: false,
        digestsVerified: false,
        chunkChecks: [],
        issues: issues.filter(item => item.assetId === trackId).map(item => item.kind),
      });
      continue;
    }

    pushEvidence(`object:${trackId}`, 'application/json', Buffer.from(JSON.stringify(entry.object)), { role: entry.objectType ?? 'TrackFile' });

    const chunkChecks = [];
    for (const chunkId of entry.chunks) {
      let check = { chunkId };
      if (!chunkCache.has(chunkId)) {
        try {
          const { bytes, etag } = await client.fetchChunk(chunkId);
          const actual = sha256Hex(bytes);
          const match = actual === etag;
          chunkCache.set(chunkId, { bytes, etag, sha256: actual, match });
          pushEvidence(`chunk:${chunkId}`, 'application/octet-stream', bytes, { etag, digestMatch: match });
          if (!match) {
            issues.push(issue('digest-mismatch', `分块 ${chunkId} 实际摘要与来源 ETag 不一致`, { chunkId, expected: etag, actual }));
          }
        } catch (error) {
          if (error.kind === 'missing') {
            chunkCache.set(chunkId, { missing: true });
            issues.push(issue('chunk-missing', `资源 ${trackId} 声明的分块缺失：${chunkId}`, { assetId: trackId, chunkId }));
          } else {
            throw error;
          }
        }
      }
      const cached = chunkCache.get(chunkId);
      check = cached.missing
        ? { chunkId, present: false, digestMatch: null }
        : { chunkId, present: true, digestMatch: cached.match, sha256: cached.sha256, etag: cached.etag };
      chunkChecks.push(check);
    }

    const presentChunks = chunkChecks.filter(item => item.present);
    const bytesComplete = entry.chunks.length > 0 && presentChunks.length === entry.chunks.length;
    const digestsVerified = bytesComplete && presentChunks.every(item => item.digestMatch);
    if (entry.chunks.length === 0) {
      issues.push(issue('no-chunks-declared', `资源 ${trackId} 没有声明任何分块，无法核对字节`, { assetId: trackId }));
    }

    assets.push({
      assetId: trackId,
      objectType: entry.objectType,
      origins: entry.origins.map(origin => ({ ...origin })),
      declaredPklHashes: entry.declaredHashes.map(item => ({ ...item })),
      usedByComposition: true,
      resolution: 'resolved',
      chunkIds: [...entry.chunks],
      chunkChecks,
      bytesComplete,
      digestsVerified,
      issues: issues.filter(item => item.assetId === trackId).map(item => item.kind),
    });
  }

  // 阶段四：统一组合时间线与复用汇总
  const { timeline, trackUsage, compositionDuration, compositionDurationSeconds } =
    buildTimeline(cplObject.resources, trackAssets);

  for (const segment of timeline) {
    for (const problem of segment.problems) {
      issues.push(issue('timeline-invalid', problem, { index: segment.index, trackFileId: segment.trackFileId }));
    }
  }

  // 三种状态彼此独立，不揉成一个布尔值
  const usedAssets = assets.filter(item => item.usedByComposition);
  const bytesComplete = usedAssets.length > 0 && usedAssets.every(item => item.bytesComplete);
  const digestsVerified = usedAssets.length > 0 && usedAssets.every(item => item.digestsVerified);
  const sufficientForComposition =
    usedAssets.length > 0 &&
    usedAssets.every(item => item.resolution === 'resolved') &&
    bytesComplete &&
    digestsVerified &&
    !issues.some(item => [
      'missing-reference', 'ambiguous-identity', 'object-missing', 'identity-mismatch',
      'unresolved-object', 'base-cpl-missing', 'timeline-invalid',
    ].includes(item.kind));

  // 记录包清单依据（AssetMap/PKL/CPL 成员标识原样留档）
  for (const pkg of catalog.packages) {
    pushEvidence(`package:${pkg.packageId}`, 'application/json', Buffer.from(JSON.stringify({
      ASSETMAP: pkg.assetMap, PKL: pkg.pkl, CPL: pkg.cpl,
    })), { role: 'package-manifest' });
  }

  return {
    compositionId: cplId,
    selectedCpl: cplId,
    baseCpl: baseCplId,
    selectedPackages: uniquePackages,
    packages: catalog.packages.map(pkg => ({ ...pkg })),
    cplDocuments,
    assets,
    timeline,
    trackUsage,
    compositionDuration: [compositionDuration[0], compositionDuration[1]],
    compositionDurationSeconds,
    status: {
      bytesComplete,           // 文件字节已齐
      digestsVerified,         // 校验通过（覆盖全部分块的摘要比对）
      sufficientForComposition, // 足以支撑这份组合
    },
    issues,
    evidence,
  };
}
