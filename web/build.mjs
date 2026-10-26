import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('./index.html', import.meta.url);
const sourceHtml = await readFile(source, 'utf8');
const {version} = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid application version');
// The browser tab and runtime build marker must use the release version.
const html = sourceHtml
  .replace(/<title>[^<]*<\/title>/, `<title>Chief of Staff v${version}</title>`)
  .replace(/const BUILD='v\d+\.\d+\.\d+/, `const BUILD='v${version}`);
if (!/^<!doctype html>/i.test(html.trimStart()) || !html.includes("const BUILD=")) {
  throw new Error('Invalid Chief of Staff source bundle');
}
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
// The release has no inline JavaScript, so CSP can block inline injection.
const inline=html.match(/<script>([\s\S]*?)<\/script>/);
if(!inline)throw Error('Missing application script');
await writeFile(new URL('./dist/app.js',import.meta.url),inline[1]);
await writeFile(new URL('./dist/index.html',import.meta.url),html.replace(inline[0],'<script src="/app.js?v='+version+'"></script>'),'utf8');
for (const name of ['redesign.css', 'dashboard.css', 'date-picker.css', 'date-picker.js', 'calendar-view.css', 'calendar-view.js', 'attention.css', 'attention.js', 'project-brief.css', 'project-brief.js', 'pdf-preview.css', 'pdf-preview.js', 'participants.css', 'participants.js', 'navigation.js', 'inbox.js', 'inbox.css', 'gmail.js', 'gmail.css', 'mail-reader.js', 'mail-reader.css','note-editor.js','projects.css','auth.css','recent-tasks.css','recent-tasks.js']) {
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
  await cp(new URL('./tests/note-editor-preview.html',import.meta.url),new URL('./dist/_note-editor-preview.html',import.meta.url));
  const readerTest=await readFile(new URL('./tests/mail-reader-browser.cjs',import.meta.url),'utf8');
  const readerFixture=readerTest.match(/const fixture=`([\s\S]*?)`;/)[1];
  await writeFile(new URL('./dist/_mail-reader-preview.html',import.meta.url),html.replace(/\bboot\(\);(?=\s*<\/script>)/,()=>readerFixture));
  const readerLayout=(await readFile(new URL('./tests/responsive-preview.html',import.meta.url),'utf8')).replace('src="/"','src="/_mail-reader-preview.html#/mail"');
  await writeFile(new URL('./dist/_mail-reader-layout.html',import.meta.url),readerLayout);
  await writeFile(new URL('./dist/_gmail-preview.html',import.meta.url),await readFile(new URL('./tests/gmail-preview.html',import.meta.url)));
  const gmailLayout=(await readFile(new URL('./tests/responsive-preview.html',import.meta.url),'utf8')).replace('src="/"','src="/_gmail-preview.html"');
  await writeFile(new URL('./dist/_gmail-layout.html',import.meta.url),gmailLayout);
  await writeFile(new URL('./dist/_design-reference.html', import.meta.url), await readFile(new URL('../docs/design-reference-v2.html', import.meta.url)));
  const referenceLayout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_design-reference.html"');
  await writeFile(new URL('./dist/_design-reference-layout.html', import.meta.url), referenceLayout);
  await writeFile(new URL('./dist/_layout-preview.html', import.meta.url), await readFile(new URL('./tests/responsive-preview.html', import.meta.url)));
  const fixture = (await readFile(new URL('./tests/project-brief-preview.html', import.meta.url), 'utf8')).replace('__BASE_STYLE__', html.match(/<style>[\s\S]*?<\/style>/)?.[0] || '');
  await writeFile(new URL('./dist/_project-brief-preview.html', import.meta.url), fixture);
  const layout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_project-brief-preview.html"');
  await writeFile(new URL('./dist/_project-brief-layout.html', import.meta.url), layout);
  const workflowFixture = await readFile(new URL('./tests/workflow-preview-fixture.js', import.meta.url), 'utf8');
  await writeFile(new URL('./dist/_workflow-preview.html', import.meta.url), html.replace(/\bboot\(\);(?=\s*<\/script>)/, () => workflowFixture));
  const designData = await readFile(new URL('./tests/design-preview-data.js', import.meta.url), 'utf8');
  const designFixture = workflowFixture.replace('  const route=initDashboardNavigation();', () => designData+'\n  const route=initDashboardNavigation();');
  await writeFile(new URL('./dist/_design-preview.html', import.meta.url), html.replace(/\bboot\(\);(?=\s*<\/script>)/, () => designFixture));
  const designLayout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_design-preview.html"');
  await writeFile(new URL('./dist/_design-layout.html', import.meta.url), designLayout);
  const workflowLayout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_workflow-preview.html"');
  await writeFile(new URL('./dist/_workflow-layout.html', import.meta.url), workflowLayout);
  const inboxFixture = await readFile(new URL('./tests/inbox-preview-fixture.js', import.meta.url), 'utf8');
  await writeFile(new URL('./dist/_inbox-preview.html', import.meta.url), html.replace(/\bboot\(\);(?=\s*<\/script>)/, () => inboxFixture));
  const inboxLayout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_inbox-preview.html"');
  await writeFile(new URL('./dist/_inbox-layout.html', import.meta.url), inboxLayout);
  const mediaFixture = await readFile(new URL('./tests/media-preview-fixture.js', import.meta.url), 'utf8');
  await writeFile(new URL('./dist/_media-preview.html', import.meta.url), html.replace(/\bboot\(\);(?=\s*<\/script>)/, () => mediaFixture));
  const mediaLayout = (await readFile(new URL('./tests/responsive-preview.html', import.meta.url), 'utf8')).replace('src="/"', 'src="/_media-preview.html"');
  await writeFile(new URL('./dist/_media-layout.html', import.meta.url), mediaLayout);
} else {
  await rm(new URL('./dist/_note-editor-preview.html',import.meta.url),{force:true});
  await rm(new URL('./dist/_mail-reader-preview.html',import.meta.url),{force:true});
  await rm(new URL('./dist/_mail-reader-layout.html',import.meta.url),{force:true});
  await rm(new URL('./dist/_gmail-preview.html',import.meta.url),{force:true});
  await rm(new URL('./dist/_gmail-layout.html',import.meta.url),{force:true});
  await rm(new URL('./dist/_design-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_design-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_design-reference.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_design-reference-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_inbox-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_inbox-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_workflow-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_workflow-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_media-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_media-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_project-brief-preview.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_project-brief-layout.html', import.meta.url), { force: true });
  await rm(new URL('./dist/_layout-preview.html', import.meta.url), { force: true });
}
console.log(`Built ${fileURLToPath(source)} (${Buffer.byteLength(html)} bytes)`);

