// Preview builds only. Synthetic PDF bytes, no project or storage writes.
(() => {
  function samplePdf() {
    const pages = ['PDF preview works - page one', 'PDF preview works - page two'];
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 640] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
      '',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 640] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
      '',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    for (let i = 0; i < pages.length; i++) {
      const stream = `BT /F1 20 Tf 35 565 Td (${pages[i]}) Tj ET`;
      objects[3 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }
    let content = '%PDF-1.4\n', offsets = [0];
    objects.forEach((object, index) => { offsets.push(content.length); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = content.length;
    content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(content);
  }
  const pdf = samplePdf();
  S.assets = ['valid', 'broken'].map(id => ({id, original_name:id === 'valid' ? 'preview-test.pdf' : 'broken-test.pdf', mime_type:'application/pdf', storage_path:'test-only.pdf', url:`/storage/v1/object/sign/preview/${id}?token=fixture`, signed_at:Date.now()}));
  netFetch = async path => new Response(String(path).includes('/broken?') ? new TextEncoder().encode('not a PDF') : pdf.slice(), {headers:{'content-type':'application/pdf'}});
  document.title = 'Проверка просмотра PDF — тестовые данные';
  $('#main').innerHTML = '<section class="page"><h1>Проверка просмотра PDF</h1><p>Тестовые документы. Данные проектов не используются и не изменяются.</p><button class="btn" id="testPdfOpen">Открыть тестовый PDF</button> <button class="btn" id="testPdfBroken">Открыть повреждённый PDF</button></section>';
  $('#testPdfOpen').onclick = () => openAsset('valid');
  $('#testPdfBroken').onclick = () => openAsset('broken');
})();
