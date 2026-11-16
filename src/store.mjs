
import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function openStore(directory) {
  await mkdir(join(directory, 'blobs'), { recursive: true });
  const journal = join(directory, 'receipts.jsonl');
  const claimJournal = join(directory, 'claims.jsonl');
  const loadJournal = async path => {
    try {
      return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  };
  let receipts = await loadJournal(journal);
  let claims = await loadJournal(claimJournal);
  let pending = Promise.resolve();
  const serialize = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  return {
    list() {
      const latest = new Map();
      for (const receipt of receipts) latest.set(receipt.key, receipt);
      return structuredClone([...latest.values()]);
    },
    history(key) {
      return structuredClone(receipts.filter(receipt => receipt.key === key));
    },
    async evidence(sha) {
      if (!/^[a-f0-9]{64}$/.test(sha)) throw Object.assign(new Error('依据标识无效'), { status: 400 });
      return readFile(join(directory, 'blobs', sha));
    },
    accept(key, record, evidence) {
      return serialize(async () => {
        if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 30) {
          throw Object.assign(new Error('收件需要原始依据，单次不超过30份'), { status: 422 });
        }
        const prepared = evidence.map(item => {
          if (!item || typeof item.source !== 'string' || !item.source.trim() || typeof item.bytesBase64 !== 'string') {
            throw Object.assign(new Error('依据必须包含来源和原始字节'), { status: 422 });
          }
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64)) {
            throw Object.assign(new Error('依据不是标准Base64'), { status: 422 });
          }
          const bytes = Buffer.from(item.bytesBase64, 'base64');
          const sha256 = digest(bytes);
          if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error('依据哈希不匹配'), { status: 422 });
          return { bytes, ref: { source: item.source, mediaType: item.mediaType ?? 'application/octet-stream', sha256, size: bytes.length } };
        });
        const refs = prepared.map(item => item.ref);
        const identity = digest(JSON.stringify({ key, record, refs }));
        const existing = receipts.find(receipt => receipt.identity === identity);
        if (existing) return { ...structuredClone(existing), duplicate: true };
        for (const item of prepared) {
          try {
            await writeFile(join(directory, 'blobs', item.ref.sha256), item.bytes, { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        const receipt = { sequence: receipts.length + 1, identity, key, record: structuredClone(record), evidence: refs, receivedAt: new Date().toISOString() };
        await appendFile(journal, JSON.stringify(receipt) + '\n');
        receipts.push(receipt);
        return { ...structuredClone(receipt), duplicate: false };
      });
    },
    // 自动组合领取：依据已由领域层取得原始字节，这里只做内容寻址落盘与建账。
    // 与人工收件分开建账，保留各自接口语义；同一 claimIdentity 幂等返回原单。
    acceptClaim(claim, evidenceItems) {
      return serialize(async () => {
        if (!claim || typeof claim !== 'object') throw Object.assign(new Error('领取内容无效'), { status: 422 });
        if (!Array.isArray(evidenceItems) || evidenceItems.length === 0 || evidenceItems.length > 100) {
          throw Object.assign(new Error('领取需要原始依据，单次不超过100份'), { status: 422 });
        }
        const prepared = evidenceItems.map(item => {
          if (!item || typeof item.source !== 'string' || !item.source.trim() || !Buffer.isBuffer(item.bytes)) {
            throw Object.assign(new Error('领取依据必须包含来源和原始字节'), { status: 422 });
          }
          const sha256 = digest(item.bytes);
          if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error('依据哈希不匹配'), { status: 422 });
          return { bytes: item.bytes, ref: { source: item.source, mediaType: item.mediaType ?? 'application/octet-stream', sha256, size: item.bytes.length, ...(item.role ? { role: item.role } : {}), ...(item.etag ? { etag: item.etag } : {}), ...(typeof item.digestMatch === 'boolean' ? { digestMatch: item.digestMatch } : {}) } };
        });
        const refs = prepared.map(item => item.ref);
        const identity = digest(JSON.stringify({ key: claim.compositionId, claim, refs }));
        const existing = claims.find(entry => entry.identity === identity);
        if (existing) return { ...structuredClone(existing), duplicate: true };
        for (const item of prepared) {
          try {
            await writeFile(join(directory, 'blobs', item.ref.sha256), item.bytes, { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        const record = {
          sequence: claims.length + 1,
          identity,
          key: claim.compositionId,
          claim: structuredClone(claim),
          evidence: refs,
          receivedAt: new Date().toISOString(),
        };
        await appendFile(claimJournal, JSON.stringify(record) + '\n');
        claims.push(record);
        return { ...structuredClone(record), duplicate: false };
      });
    },
    listClaims() {
      const latest = new Map();
      for (const entry of claims) latest.set(entry.identity, entry);
      return structuredClone([...latest.values()]);
    },
    claimHistory(key) {
      return structuredClone(claims.filter(entry => entry.key === key));
    },
    claim(identity) {
      const found = claims.find(entry => entry.identity === identity);
      if (!found) throw Object.assign(new Error('领取单不存在'), { status: 404 });
      return structuredClone(found);
    },
    flush() { return pending; },
  };
}
