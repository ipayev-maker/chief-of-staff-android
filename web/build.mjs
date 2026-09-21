import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('./index.html', import.meta.url);
const html = await readFile(source, 'utf8');
if (!/^<!doctype html>/i.test(html.trimStart()) || !html.includes("const BUILD=")) {
  throw new Error('Invalid Chief of Staff source bundle');
}
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/index.html', import.meta.url), html, 'utf8');
console.log(`Built ${fileURLToPath(source)} (${Buffer.byteLength(html)} bytes)`);
