import { readFileSync } from 'node:fs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * PDF のテキスト抽出とページ画像化。pdfjs-dist(legacy build)+ @napi-rs/canvas を使い、
 * main プロセスだけで完結させる(ネイティブビルド不要の Node-API バイナリ)。
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type Canvas = typeof import('@napi-rs/canvas');

let pdfjsPromise: Promise<PdfJs> | null = null;
let canvasPromise: Promise<Canvas> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}
function loadCanvas(): Promise<Canvas> {
  canvasPromise ??= import('@napi-rs/canvas');
  return canvasPromise;
}

export interface PdfInfo {
  numPages: number;
  title: string | null;
}

export interface PdfTextResult {
  numPages: number;
  /** 1 ページ目から順(要求範囲のみ) */
  pages: { page: number; text: string }[];
}

export interface PdfPageImage {
  page: number;
  jpeg: Buffer;
  width: number;
  height: number;
}

export class PdfService {
  private async open(
    path: string,
  ): Promise<{ task: PDFDocumentLoadingTask; doc: PDFDocumentProxy }> {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(readFileSync(path));
    const task = pdfjs.getDocument({ data, useSystemFonts: true });
    return { task, doc: await task.promise };
  }

  async info(path: string): Promise<PdfInfo> {
    const { task, doc } = await this.open(path);
    try {
      const meta = (await doc.getMetadata().catch(() => null)) as {
        info?: { Title?: string };
      } | null;
      return { numPages: doc.numPages, title: meta?.info?.Title?.trim() || null };
    } finally {
      await task.destroy();
    }
  }

  /** ページ範囲(1 始まり、両端含む)のテキストを取り出す */
  async extractText(path: string, from = 1, to = Infinity): Promise<PdfTextResult> {
    const { task, doc } = await this.open(path);
    try {
      const last = Math.min(doc.numPages, to);
      const pages: PdfTextResult['pages'] = [];
      for (let p = Math.max(1, from); p <= last; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        // 行の区切りを保つ: item の hasEOL で改行、それ以外はスペース
        let text = '';
        for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
          if (item.str === undefined) continue;
          text += item.str;
          text += item.hasEOL ? '\n' : ' ';
        }
        pages.push({
          page: p,
          text: text
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim(),
        });
        page.cleanup();
      }
      return { numPages: doc.numPages, pages };
    } finally {
      await task.destroy();
    }
  }

  /** 指定ページを JPEG にする(幅を指定、既定 1024px) */
  async renderPages(
    path: string,
    pageNumbers: number[],
    opts: { width?: number; quality?: number } = {},
  ): Promise<PdfPageImage[]> {
    const [{ task, doc }, canvasMod] = await Promise.all([this.open(path), loadCanvas()]);
    try {
      const width = opts.width ?? 1024;
      const out: PdfPageImage[] = [];
      for (const n of pageNumbers) {
        if (n < 1 || n > doc.numPages) continue;
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const viewport = page.getViewport({ scale });
        const w = Math.ceil(viewport.width);
        const h = Math.ceil(viewport.height);
        const canvas = canvasMod.createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        // pdf.js は DOM の Canvas 型を要求するが、@napi-rs/canvas は互換 API を持つ
        type RenderParams = Parameters<typeof page.render>[0];
        const params = {
          canvasContext: ctx,
          viewport,
          canvas,
        } as unknown as RenderParams;
        await page.render(params).promise;
        out.push({
          page: n,
          jpeg: canvas.toBuffer('image/jpeg', opts.quality ?? 85),
          width: w,
          height: h,
        });
        page.cleanup();
      }
      return out;
    } finally {
      await task.destroy();
    }
  }
}
