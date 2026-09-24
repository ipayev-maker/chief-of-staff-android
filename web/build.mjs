import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('./index.html', import.meta.url);
const html = await readFile(source, 'utf8');
if (!/^<!doctype html>/i.test(html.trimStart()) || !html.includes("const BUILD=")) {
  throw new Error('Invalid Chief of Staff source bundle');
}
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/index.html', import.meta.url), html, 'utf8');
for (const name of ['dashboard.css', 'date-picker.css', 'date-picker.js', 'calendar-view.css', 'calendar-view.js', 'attention.css', 'attention.js', 'project-brief.css', 'project-brief.js', 'pdf-preview.css', 'pdf-preview.js']) {
  await writeFile(new URL(`./dist/${name}`, import.meta.url), await readFile(new URL(`./${name}`, import.meta.url)));
}
// Same-origin PDF renderer and worker; private documents never go to an external viewer.
const pdfVersion = '6.3.289';
const pdfSource = new URL('./node_modules/pdfjs-dist/', import.meta.url);
if (JSON.parse(await readFile(new URL('package.json', pdfSource), 'utf8')).version !== pdfVersion) throw Error('Unexpected PDF.js version');
const pdfTarget = new URL(`./dist/vendor/pdfjs/${pdfVersion}/`, import.meta.url);
await mkdir(pdfTarget, { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) await cp(new URL(`build/${name}`, pdfSource), new URL(name, pdfTarget));
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(new URL(name, pdfSource), new URL(name, pdfTarget), { recursive: true });
await cp(new URL('LICENSE', pdfSource), new URL('LICENSE', pdfTarget));
// A real iframe viewport for manual responsive checks, never emitted in production.
if (process.env.VERCEL_ENV === 'preview') {
  await writeFile(new URL('./dist/_layout-preview.html', import.meta.url), await readFile(new URL('./tests/responsive-preview.html', import.meta.url)));
  const fixture = (await readFile(new URL('./tests/project-brief-preview.html', import.meta.url), 'utf8')).replace('__BASE_STYLE__', html.match(/<style>[\s\S]*?<\/style>/)?.[0] || '');
  await writeFile(new URL('./dist/_project-brief-preview.html', import.meta.url), fixture);
  const layout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_project-brief-preview.html"');
  await writeFile(new URL('./dist/_project-brief-layout.html', import.meta.url), layout);
  const mediaFixture = await readFile(new URL('./tests/media-preview-fixture.js', import.meta.url), 'utf8');
  await writeFile(new URL('./dist/_media-preview.html', import.meta.url), html.replace(/\bboot\(\);(?=\s*<\/script>)/, () => mediaFixture));
  const mediaLayout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_media-preview.html"');
  await writeFile(new URL('./dist/_media-layout.html', import.meta.url), mediaLayout);
} else {
  await rm(new URL('./dist/_media-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_media-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_project-brief-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_project-brief-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_layout-preview.html', import.meta.url), { force: true });
}
console.log(`Built ${fileURLToPath(source)} (${Buffer.byteLength(html)} bytes)`);
