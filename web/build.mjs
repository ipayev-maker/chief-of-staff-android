import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('./index.html', import.meta.url);
const html = await readFile(source, 'utf8');
if (!/^<!doctype html>/i.test(html.trimStart()) || !html.includes("const BUILD=")) {
  throw new Error('Invalid Chief of Staff source bundle');
}
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/index.html', import.meta.url), html, 'utf8');
for (const name of ['dashboard.css', 'date-picker.css', 'date-picker.js']) {
  await writeFile(new URL(`./dist/${name}`, import.meta.url), await readFile(new URL(`./${name}`, import.meta.url)));
}
console.log(`Built ${fileURLToPath(source)} (${Buffer.byteLength(html)} bytes)`);
