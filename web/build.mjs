import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('./index.html', import.meta.url);
const html = await readFile(source, 'utf8');
if (!/^<!doctype html>/i.test(html.trimStart()) || !html.includes("const BUILD=")) {
  throw new Error('Invalid Chief of Staff source bundle');
}
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/index.html', import.meta.url), html, 'utf8');
for (const name of ['dashboard.css', 'date-picker.css', 'date-picker.js', 'calendar-view.css', 'calendar-view.js', 'attention.css', 'attention.js', 'project-brief.css', 'project-brief.js']) {
  await writeFile(new URL(`./dist/${name}`, import.meta.url), await readFile(new URL(`./${name}`, import.meta.url)));
}
// A real iframe viewport for manual responsive checks, never emitted in production.
if (process.env.VERCEL_ENV === 'preview') {
  await writeFile(new URL('./dist/_layout-preview.html', import.meta.url), await readFile(new URL('./tests/responsive-preview.html', import.meta.url)));
  const fixture = (await readFile(new URL('./tests/project-brief-preview.html', import.meta.url), 'utf8')).replace('__BASE_STYLE__', html.match(/<style>[\s\S]*?<\/style>/)?.[0] || '');
  await writeFile(new URL('./dist/_project-brief-preview.html', import.meta.url), fixture);
  const layout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_project-brief-preview.html"');
  await writeFile(new URL('./dist/_project-brief-layout.html', import.meta.url), layout);
} else {
  await rm(new URL('./dist/_project-brief-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_project-brief-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_layout-preview.html', import.meta.url), { force: true });
}
console.log(`Built ${fileURLToPath(source)} (${Buffer.byteLength(html)} bytes)`);
