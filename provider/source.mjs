
import { readFile } from 'node:fs/promises';
import { serve, json, bytes } from './http.mjs';
const data = JSON.parse(await readFile(new URL('../fixtures/objects.json', import.meta.url)));
const chunks = JSON.parse(await readFile(new URL('../fixtures/chunks.json', import.meta.url)));
export async function startProvider(options = {}) {
  return serve(async ({ request, response, url }) => {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'packages' && parts.length === 2 && data.packages[parts[1]]) return json(response, data.packages[parts[1]]);
    if (parts[0] === 'objects' && parts.length === 2) {
      const object = data.resources[parts[1]] ?? data.resources.duplicate;
      if (object.id !== parts[1]) return json(response, { error: 'missing' }, 404);
      return json(response, { ...object, package: parts[1] === 'cpl-localized' || parts[1] === 'new-language' ? 'supplement' : 'base' });
    }
    if (parts[0] === 'chunks' && parts.length === 2) {
      const encoded = chunks[parts[1]];
      if (!encoded) return json(response, { error: 'missing' }, 404);
      const body = Buffer.from(encoded, 'base64');
      const expected = data.chunks[parts[1]];
      if (request.headers['if-match'] && request.headers['if-match'] !== `"${expected}"`) return json(response, { error: 'changed' }, 412);
      return bytes(response, body, 'application/octet-stream', 200, { etag: `"${expected}"` });
    }
    return false;
  }, options);
}
