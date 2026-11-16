// 合作来源 HTTP 客户端。
// 只使用 docs/source-contract.md 声明的入口：
//   GET /packages/{id}      包的 AssetMap / PKL / CPL 成员标识
//   GET /objects/{id}       成员对象（CPL 或 TrackFile）
//   GET /chunks/{id}        分块字节，ETag 为该分块的 sha256 摘要
// 不读取来源服务的内部数据结构，也不预设采集结论。

export class SourceError extends Error {
  constructor(message, { kind, status, id } = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind; // unreachable | missing | corrupt | changed
    this.status = status;
    this.id = id;
  }
}

export function createSourceClient(baseUrl, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('需要来源服务地址 sourceBaseUrl');
  }
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  async function getJson(path, id) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SourceError(`来源不可达：${path}（${error.message}）`, { kind: 'unreachable', id });
    }
    if (response.status === 404) {
      throw new SourceError(`来源声明找不到对象：${id}`, { kind: 'missing', status: 404, id });
    }
    if (!response.ok) {
      throw new SourceError(`来源返回异常状态 ${response.status}：${id}`, { kind: 'unreachable', status: response.status, id });
    }
    try {
      return await response.json();
    } catch {
      throw new SourceError(`来源返回的不是有效JSON：${id}`, { kind: 'corrupt', id });
    }
  }

  return {
    baseUrl: base,

    async fetchPackage(packageId) {
      const manifest = await getJson(`/packages/${encodeURIComponent(packageId)}`, packageId);
      for (const listName of ['ASSETMAP', 'PKL', 'CPL']) {
        if (!Array.isArray(manifest[listName]) || manifest[listName].some(id => typeof id !== 'string')) {
          throw new SourceError(`包 ${packageId} 的 ${listName} 成员清单无效`, { kind: 'corrupt', id: packageId });
        }
      }
      return manifest;
    },

    async fetchObject(objectId) {
      const object = await getJson(`/objects/${encodeURIComponent(objectId)}`, objectId);
      if (!object || typeof object.id !== 'string') {
        throw new SourceError(`对象 ${objectId} 缺少有效身份标识`, { kind: 'corrupt', id: objectId });
      }
      return object;
    },

    // 返回 { bytes, etag }；ETag 去掉引号，按契约是分块字节的 sha256
    async fetchChunk(chunkId) {
      let response;
      try {
        response = await fetchImpl(`${base}/chunks/${encodeURIComponent(chunkId)}`, {
          headers: { accept: 'application/octet-stream' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new SourceError(`来源不可达：分块 ${chunkId}（${error.message}）`, { kind: 'unreachable', id: chunkId });
      }
      if (response.status === 404) {
        throw new SourceError(`来源缺少分块：${chunkId}`, { kind: 'missing', status: 404, id: chunkId });
      }
      if (!response.ok) {
        throw new SourceError(`分块 ${chunkId} 返回异常状态 ${response.status}`, { kind: 'unreachable', status: response.status, id: chunkId });
      }
      const rawEtag = response.headers.get('etag') ?? '';
      const etag = rawEtag.replace(/^"|"$/g, '');
      if (!/^[a-f0-9]{64}$/.test(etag)) {
        throw new SourceError(`分块 ${chunkId} 的 ETag 不是 sha256 形式`, { kind: 'corrupt', id: chunkId });
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, etag };
    },
  };
}
