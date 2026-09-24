(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoSPdfPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const VENDOR = '/vendor/pdfjs/6.3.289/';
  const MAX_PIXELS = 4000000;
  let libraryPromise;

  function loadLibrary() {
    if (!libraryPromise) libraryPromise = import('/vendor/pdfjs/6.3.289/pdf.mjs').catch(error => {
      libraryPromise = null;
      throw error;
    });
    return libraryPromise;
  }

  function documentOptions(bytes) {
    // PDF.js transfers the buffer to its worker. Keep the caller's bytes intact.
    const data = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()
      : new Uint8Array(bytes).slice();
    if (!data.length) throw new Error('Empty PDF');
    return {
      data, cMapUrl: VENDOR + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: VENDOR + 'standard_fonts/',
      wasmUrl: VENDOR + 'wasm/', iccUrl: VENDOR + 'iccs/',
      enableXfa: false,
      // Retained for compatibility with older PDF.js versions that honor it.
      isEvalSupported: false,
      canvasMaxAreaInBytes: MAX_PIXELS * 4,
      disableAutoFetch: true, disableStream: true, disableRange: true,
      verbosity: 0
    };
  }

  function canvasGeometry(width, height, availableWidth, zoom = 1, deviceRatio = 1) {
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid page size');
    const fit = Math.min(Math.max(1, Number(availableWidth) || 720) / width, 50000 / height);
    const scale = fit * Math.min(2, Math.max(0.5, Number(zoom) || 1));
    const cssWidth = width * scale, cssHeight = height * scale;
    const ratio = Math.min(Math.max(1, Number(deviceRatio) || 1), 2,
      Math.sqrt(MAX_PIXELS / (cssWidth * cssHeight)), 8192 / cssWidth, 8192 / cssHeight);
    return { scale, cssWidth, cssHeight, ratio,
      width: Math.max(1, Math.floor(cssWidth * ratio)),
      height: Math.max(1, Math.floor(cssHeight * ratio)) };
  }

  function errorMessage(error) {
    if (error?.name === 'PasswordException') return 'PDF защищён паролем. Скачайте файл и откройте его на устройстве.';
    if (error?.name === 'InvalidPDFException') return 'Не удалось прочитать PDF. Скачайте файл и проверьте его на устройстве.';
    return 'Не удалось показать PDF. Скачайте файл и откройте его на устройстве.';
  }

  // Dependencies are injectable for lifecycle tests; normal callers use two arguments.
  function mount(container, options = {}, dependencies = {}) {
    const doc = dependencies.document || root.document;
    const importLibrary = dependencies.loadLibrary || loadLibrary;
    const Observer = dependencies.ResizeObserver || root.ResizeObserver;
    const pixelRatio = dependencies.devicePixelRatio || (() => root.devicePixelRatio || 1);
    const create = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const widget = create('section', 'pdf-preview');
    widget.setAttribute('aria-label', options.title ? 'Просмотр PDF: ' + options.title : 'Просмотр PDF');
    const toolbar = create('div', 'pdf-preview-toolbar');
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Страницы и масштаб PDF');
    const button = (text, label) => {
      const node = create('button', 'btn small', text);
      node.type = 'button'; node.disabled = true; node.setAttribute('aria-label', label);
      toolbar.appendChild(node); return node;
    };
    const previous = button('←', 'Предыдущая страница PDF');
    const count = create('span', 'pdf-preview-count', 'Загрузка…');
    count.setAttribute('aria-live', 'polite'); toolbar.appendChild(count);
    const next = button('→', 'Следующая страница PDF');
    const minus = button('−', 'Уменьшить PDF');
    const fit = button('По ширине', 'Масштаб PDF по ширине');
    const plus = button('+', 'Увеличить PDF');
    const status = create('p', 'pdf-preview-status', 'Подготавливаю PDF…');
    status.setAttribute('role', 'status');
    const viewport = create('div', 'pdf-preview-viewport');
    viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Страница PDF');
    const canvas = create('canvas', 'pdf-preview-canvas');
    canvas.hidden = true; canvas.setAttribute('role', 'img');
    viewport.appendChild(canvas);
    widget.appendChild(toolbar); widget.appendChild(status); widget.appendChild(viewport);
    container.replaceChildren(widget);

    let disposed = false, loadingTask = null, pdf = null, currentPage = null;
    let renderTask = null, running = null, observer = null, destroyStarted = false;
    let pageNumber = 1, zoom = 1, requested = 0, completed = 0, lastWidth = 0;

    function updateControls(busy) {
      if (disposed) return;
      previous.disabled = busy || !pdf || pageNumber <= 1;
      next.disabled = busy || !pdf || pageNumber >= pdf.numPages;
      minus.disabled = busy || !pdf || zoom <= 0.5;
      plus.disabled = busy || !pdf || zoom >= 2;
      fit.disabled = busy || !pdf;
      widget.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function showError(error) {
      if (disposed) return;
      status.textContent = errorMessage(error); status.hidden = false;
      canvas.hidden = true; updateControls(false);
    }
    function destroyLoadingTask() {
      if (!loadingTask || destroyStarted) return;
      destroyStarted = true;
      try { Promise.resolve(loadingTask.destroy()).catch(() => {}); } catch {}
    }
    function cleanupPage(page) { try { page?.cleanup(); } catch {} }

    async function renderPending() {
      updateControls(true);
      try {
        while (!disposed && completed !== requested) {
          const request = requested, target = pageNumber;
          status.textContent = 'Загружаю страницу…'; status.hidden = false;
          const page = await pdf.getPage(target);
          if (disposed) { cleanupPage(page); return; }
          if (request !== requested) { cleanupPage(page); continue; }
          if (currentPage && currentPage !== page) cleanupPage(currentPage);
          currentPage = page;
          const base = page.getViewport({ scale: 1 });
          const width = Math.max(1, (viewport.clientWidth || container.clientWidth || 744) - 24);
          const size = canvasGeometry(base.width, base.height, width, zoom, pixelRatio());
          const view = page.getViewport({ scale: size.scale });
          canvas.width = size.width; canvas.height = size.height;
          canvas.style.width = size.cssWidth + 'px'; canvas.style.height = size.cssHeight + 'px';
          canvas.hidden = false;
          canvas.setAttribute('aria-label', 'Страница ' + target + ' из ' + pdf.numPages);
          renderTask = page.render({ canvasContext: canvas.getContext('2d'), canvas,
            viewport: view, transform: [size.ratio, 0, 0, size.ratio, 0, 0],
            annotationMode: 0, background: 'rgb(255,255,255)' });
          await renderTask.promise;
          renderTask = null;
          if (disposed) return;
          completed = request;
          count.textContent = target + ' / ' + pdf.numPages;
          status.textContent = ''; status.hidden = true;
        }
      } finally { running = null; if (!disposed) updateControls(false); }
    }
    function redraw() {
      if (disposed || !pdf) return Promise.resolve();
      requested++;
      if (!running) running = Promise.resolve().then(renderPending);
      return running;
    }
    function changePage(delta) {
      if (disposed || !pdf || running) return;
      pageNumber = Math.min(pdf.numPages, Math.max(1, pageNumber + delta));
      viewport.scrollTop = 0; viewport.scrollLeft = 0;
      redraw().catch(showError);
    }
    previous.onclick = () => changePage(-1); next.onclick = () => changePage(1);
    function changeZoom(value) {
      if (disposed || !pdf || running) return;
      zoom = Math.min(2, Math.max(0.5, value)); redraw().catch(showError);
    }
    minus.onclick = () => changeZoom(zoom - 0.25);
    plus.onclick = () => changeZoom(zoom + 0.25);
    fit.onclick = () => changeZoom(1);

    const ready = (async () => {
      try {
        const library = await importLibrary();
        if (disposed) return;
        library.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.mjs';
        loadingTask = library.getDocument(documentOptions(options.bytes));
        pdf = await loadingTask.promise;
        if (disposed) return;
        if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('No PDF pages');
        await redraw();
        if (disposed) return;
        if (Observer) {
          lastWidth = viewport.clientWidth;
          observer = new Observer(() => {
            if (disposed) return;
            const width = viewport.clientWidth;
            if (width > 0 && Math.abs(width - lastWidth) >= 1) {
              lastWidth = width; redraw().catch(showError);
            }
          });
          observer.observe(viewport);
        }
      } catch (error) {
        if (disposed) return;
        showError(error); destroyLoadingTask();
        const friendly = new Error(errorMessage(error), { cause: error });
        friendly.name = error?.name || 'Error';
        throw friendly;
      }
    })();
    // Retain the rejected promise for the caller, without leaking an unhandled rejection.
    ready.catch(() => {});
    return { ready, dispose() {
      if (disposed) return;
      disposed = true; observer?.disconnect(); observer = null;
      try { renderTask?.cancel(); } catch {}
      destroyLoadingTask();
      if (!renderTask) cleanupPage(currentPage);
      canvas.width = 1; canvas.height = 1;
      previous.onclick = next.onclick = minus.onclick = plus.onclick = fit.onclick = null;
    } };
  }
  return { mount, canvasGeometry, documentOptions, errorMessage };
});
