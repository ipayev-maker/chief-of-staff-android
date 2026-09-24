const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, canvasGeometry, documentOptions, errorMessage } = require('../pdf-preview.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.style = {};
    this.clientWidth = 600; this.textContent = ''; this.hidden = false;
  }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getContext() { return {}; }
}
function all(node) { return [node, ...node.children.flatMap(all)]; }
function find(h, name) { return all(h.container).find(node => node.attributes['aria-label'] === name); }
function harness(overrides = {}) {
  const calls = { documents: [], pages: [], renders: [], destroyed: 0, cancelled: 0, cleaned: [], observers: [] };
  const container = new Element('div');
  const pdf = { numPages: 3, async getPage(number) {
    calls.pages.push(number);
    if (overrides.getPage) return overrides.getPage(number);
    return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 900 * scale }),
      cleanup() { calls.cleaned.push(number); },
      render(config) {
        calls.renders.push(config);
        return { promise: overrides.renderPromise || Promise.resolve(), cancel() {
          calls.cancelled++;
          overrides.onCancel?.();
        } };
      } };
  } };
  const library = { GlobalWorkerOptions: {}, getDocument(options) {
    calls.documents.push(options);
    return { promise: overrides.documentPromise || Promise.resolve(pdf), destroy() { calls.destroyed++; return Promise.resolve(); } };
  } };
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; calls.observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
  }
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
  const dependencies = { document: { createElement: tag => new Element(tag) },
    ResizeObserver: Observer, devicePixelRatio: () => 3,
    loadLibrary: () => overrides.libraryPromise || Promise.resolve(library) };
  const view = mount(container, { bytes, title: '<img onerror=alert(1)>' }, dependencies);
  return { view, container, library, calls, bytes, pdf };
}

test('document options clone source bytes and keep PDF resources on the app origin', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const input = source.subarray(1, 3), options = documentOptions(input);
  assert.deepEqual([...options.data], [2, 3]);
  options.data[0] = 99; assert.equal(source[1], 2);
  const transferred = structuredClone(options.data, { transfer: [options.data.buffer] });
  assert.equal(transferred.length, 2); assert.equal(source.byteLength, 4);
  for (const name of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) {
    assert.ok(options[name].startsWith('/vendor/pdfjs/6.3.289/'));
  }
  assert.equal(options.enableXfa, false); assert.equal(options.isEvalSupported, false);
  assert.equal(options.url, undefined); assert.equal(options.canvasMaxAreaInBytes, 16000000);
  assert.throws(() => documentOptions(new ArrayBuffer(0)));
  assert.deepEqual([...documentOptions(source.buffer).data], [...source]);
});

test('canvas sizing preserves aspect ratio and caps pixels, dimensions and density', () => {
  for (const [width, height] of [[600, 900], [10000, 10000], [1, 10000000], [10000000, 1]]) {
    for (const available of [300, 1200, 10000]) {
      const result = canvasGeometry(width, height, available, 2, 4);
      assert.ok(result.width * result.height <= 4000000);
      assert.ok(result.width <= 8192 && result.height <= 8192);
      assert.ok(result.ratio <= 2);
      assert.ok(Math.abs(result.cssWidth / result.cssHeight - width / height) < 0.001);
    }
  }
  assert.throws(() => canvasGeometry(0, 100, 400));
  assert.throws(() => canvasGeometry(Infinity, 100, 400));
});

test('first page renders on canvas only, with scripts, forms and annotation layer absent', async () => {
  const h = harness(); await h.view.ready;
  assert.deepEqual(h.calls.pages, [1]);
  assert.equal(h.calls.renders[0].annotationMode, 0);
  assert.equal(h.library.GlobalWorkerOptions.workerSrc, '/vendor/pdfjs/6.3.289/pdf.worker.mjs');
  assert.ok(all(h.container).some(node => node.tagName === 'canvas'));
  assert.ok(all(h.container).every(node => !['iframe', 'embed', 'object', 'script', 'a', 'input'].includes(node.tagName)));
  assert.equal(find(h, 'Предыдущая страница PDF').disabled, true);
  assert.equal(find(h, 'Следующая страница PDF').disabled, false);
  assert.equal(h.bytes.byteLength, 8);
  h.view.dispose(); assert.equal(h.calls.destroyed, 1);
});

test('navigation and zoom render sequentially and clean the preceding page', async () => {
  const h = harness(); await h.view.ready;
  find(h, 'Следующая страница PDF').onclick(); await tick();
  assert.deepEqual(h.calls.pages, [1, 2]); assert.ok(h.calls.cleaned.includes(1));
  assert.equal(find(h, 'Предыдущая страница PDF').disabled, false);
  find(h, 'Увеличить PDF').onclick(); await tick();
  assert.ok(h.calls.renders[2].viewport.width > h.calls.renders[1].viewport.width);
  find(h, 'Масштаб PDF по ширине').onclick(); await tick();
  assert.equal(h.calls.renders[3].viewport.width, h.calls.renders[1].viewport.width);
  find(h, 'Следующая страница PDF').onclick(); await tick();
  assert.equal(find(h, 'Следующая страница PDF').disabled, true);
  h.view.dispose();
});

test('dispose before lazy module load never creates a document or updates the DOM', async () => {
  const load = deferred(), h = harness({ libraryPromise: load.promise });
  const before = JSON.stringify(h.container);
  h.view.dispose(); load.resolve(h.library); await h.view.ready;
  assert.equal(h.calls.documents.length, 0); assert.equal(h.calls.observers.length, 0);
  // Disposal only releases the canvas allocation and click handlers.
  const status = all(h.container).find(node => node.className === 'pdf-preview-status');
  assert.equal(status.textContent, 'Подготавливаю PDF…'); assert.ok(before);
});

test('dispose while document is loading destroys it once and ignores late resolution', async () => {
  const loading = deferred(), h = harness({ documentPromise: loading.promise });
  await tick(); h.view.dispose(); h.view.dispose();
  loading.resolve(h.pdf); await h.view.ready;
  assert.equal(h.calls.destroyed, 1); assert.deepEqual(h.calls.pages, []);
});

test('dispose while rendering cancels the render and absorbs its rejection', async () => {
  const rendering = deferred();
  const h = harness({ renderPromise: rendering.promise, onCancel() {
    rendering.reject(Object.assign(new Error('cancel'), { name: 'RenderingCancelledException' }));
  } });
  await tick(); assert.equal(h.calls.renders.length, 1);
  h.view.dispose(); await h.view.ready;
  assert.equal(h.calls.cancelled, 1); assert.equal(h.calls.destroyed, 1);
  assert.equal(all(h.container).find(node => node.tagName === 'canvas').width, 1);
});

test('password and malformed PDFs reject ready with a friendly download fallback', async () => {
  for (const name of ['PasswordException', 'InvalidPDFException']) {
    const loading = deferred(), h = harness({ documentPromise: loading.promise });
    loading.reject(Object.assign(new Error('<secret raw parse error>'), { name }));
    await assert.rejects(h.view.ready, error => error.name === name && error.message.includes('Скачайте файл') && !error.message.includes('<secret'));
    const status = all(h.container).find(node => node.className === 'pdf-preview-status');
    assert.ok(status.textContent.includes('Скачайте файл'));
    assert.ok(!status.textContent.includes('<secret'));
    assert.equal(h.calls.destroyed, 1); h.view.dispose(); assert.equal(h.calls.destroyed, 1);
  }
  assert.ok(errorMessage({ name: 'PasswordException' }).includes('паролем'));
});

test('module load failure rejects cleanly without creating worker or navigating away', async () => {
  const loading = deferred(), h = harness({ libraryPromise: loading.promise });
  loading.reject(new Error('Network failed')); await assert.rejects(h.view.ready);
  assert.equal(h.calls.documents.length, 0);
  assert.ok(all(h.container).find(node => node.className === 'pdf-preview-status').textContent.includes('Скачайте'));
  h.view.dispose();
});

test('resize rerenders the visible page, ignores equal widths and disconnects on close', async () => {
  const h = harness(); await h.view.ready;
  const observer = h.calls.observers[0];
  observer.callback(); await tick(); assert.equal(h.calls.renders.length, 1);
  observer.node.clientWidth = 350; observer.callback(); await tick();
  assert.equal(h.calls.renders.length, 2);
  assert.ok(h.calls.renders[1].viewport.width < h.calls.renders[0].viewport.width);
  h.view.dispose(); assert.equal(observer.disconnected, true);
  observer.node.clientWidth = 700; observer.callback(); await tick();
  assert.equal(h.calls.renders.length, 2);
});

test('rapid resize requests never overlap canvas renders', async () => {
  const h = harness(); await h.view.ready;
  const rendering = deferred(), originalGetPage = h.pdf.getPage;
  let active = 0, maximum = 0;
  h.pdf.getPage = async number => {
    const page = await originalGetPage(number);
    page.render = () => {
      active++; maximum = Math.max(maximum, active);
      return { promise: rendering.promise.finally(() => { active--; }), cancel() {} };
    };
    return page;
  };
  const observer = h.calls.observers[0];
  observer.node.clientWidth = 500; observer.callback(); await tick();
  observer.node.clientWidth = 400; observer.callback();
  observer.node.clientWidth = 300; observer.callback();
  await tick(); assert.equal(maximum, 1);
  rendering.resolve(); await tick(); await tick();
  assert.equal(maximum, 1); assert.equal(active, 0); h.view.dispose();
});
