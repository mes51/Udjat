/**
 * テスト用のフィクスチャ生成(テストからのみ import する)。
 */

/** 最小の PDF(Helvetica のテキスト、複数ページ)を手書きで作る */
export function minimalPdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const pageIds: number[] = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('PAGES'); // 後で差し替え
  const fontId = 3;
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const lines of pages) {
    const content =
      'BT /F1 24 Tf 72 720 Td ' +
      lines.map((l, i) => `${i === 0 ? '' : '0 -40 Td '}(${l}) Tj`).join(' ') +
      ' ET';
    const contentId = objs.length + 1;
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageId = objs.length + 1;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    pageIds.push(pageId);
  }
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
