import type { Attachment } from '@shared/schemas';
import type { PdfService } from '@main/media/pdf';
import type { MediaStore } from '@main/media/store';
import type { RegisteredTool, ToolMedia } from '../types';
import { fail, num, ok, str, ToolError } from '../types';

/**
 * PDF ツール群。添付時にテキストを送っているので、ここでは
 * 切り詰められた範囲の再読込(pdf_text)と、図表を見るためのページ画像化(pdf_pages)を提供する。
 */

export interface PdfToolDeps {
  store: MediaStore;
  pdf: PdfService;
}

function requirePdf(store: MediaStore, id: string): Attachment {
  const a = store.get(id);
  if (!a)
    throw new ToolError(`pdf_id ${id} は存在しません。添付された PDF の pdf_id を使ってください`);
  if (a.mime !== 'application/pdf') throw new ToolError(`${id} は PDF ではありません (${a.mime})`);
  return a;
}

function parsePages(args: Record<string, unknown>, numPages: number, max: number): number[] {
  const raw = args['pages'];
  let pages: number[] = [];
  if (Array.isArray(raw)) pages = raw.map(Number);
  else if (typeof raw === 'string') {
    // "1-3,5" 形式
    for (const part of raw.split(',')) {
      const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
      if (!m) continue;
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      for (let p = a; p <= b; p++) pages.push(p);
    }
  } else if (typeof raw === 'number') pages = [raw];
  pages = [...new Set(pages.filter((p) => Number.isInteger(p) && p >= 1 && p <= numPages))];
  return pages.slice(0, max);
}

export function createPdfTools({ store, pdf }: PdfToolDeps): RegisteredTool[] {
  const pdfText: RegisteredTool = {
    definition: {
      name: 'pdf_text',
      description:
        '添付 PDF の指定ページのテキストを返す。添付時に送られた本文が途中で切れている時や、特定ページを読み直したい時に使う。',
      parameters: {
        type: 'object',
        properties: {
          pdf_id: { type: 'string', description: '添付の pdf_id' },
          pages: {
            type: 'string',
            description: 'ページ指定。例: "3" / "2-5" / "1,4,7" (1 始まり、最大 20 ページ)',
          },
        },
        required: ['pdf_id', 'pages'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    defaultPolicy: 'auto',
    execute: async (args) => {
      const a = requirePdf(store, str(args, 'pdf_id'));
      const numPages = a.meta.pageCount ?? (await pdf.info(store.pathOf(a))).numPages;
      const pages = parsePages(args, numPages, 20);
      if (pages.length === 0) return fail(`有効なページがありません (1〜${numPages})`);
      const out: { page: number; text: string }[] = [];
      for (const p of pages) {
        const r = await pdf.extractText(store.pathOf(a), p, p);
        if (r.pages[0]) out.push(r.pages[0]);
      }
      return ok(JSON.stringify({ pdf_id: a.id, num_pages: numPages, pages: out }));
    },
  };

  const pdfPages: RegisteredTool = {
    definition: {
      name: 'pdf_pages',
      description:
        '添付 PDF の指定ページを画像にして返す。図・表・レイアウトを見る必要がある時に使う(テキストだけなら pdf_text)。枚数は控えめに(最大 8 ページ)。',
      parameters: {
        type: 'object',
        properties: {
          pdf_id: { type: 'string' },
          pages: {
            type: 'string',
            description: 'ページ指定。例: "1" / "2-4" (1 始まり、最大 8 ページ)',
          },
          width: {
            type: 'integer',
            description: '画像の幅 px (既定 1024)',
            minimum: 256,
            maximum: 2048,
          },
        },
        required: ['pdf_id', 'pages'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    defaultPolicy: 'auto',
    requires: { image: true },
    execute: async (args) => {
      const a = requirePdf(store, str(args, 'pdf_id'));
      const numPages = a.meta.pageCount ?? (await pdf.info(store.pathOf(a))).numPages;
      const pages = parsePages(args, numPages, 8);
      if (pages.length === 0) return fail(`有効なページがありません (1〜${numPages})`);
      const width = num(args, 'width', 1024, 256, 2048);
      const rendered = await pdf.renderPages(store.pathOf(a), pages, { width });
      const media: ToolMedia[] = [];
      for (const r of rendered) {
        const img = await store.addBytes(r.jpeg, `${a.originalName}.p${r.page}.jpg`, 'image/jpeg', {
          derivedFrom: a.id,
          derivedLabel: `page ${r.page}`,
        });
        media.push({
          attachmentId: img.id,
          mime: 'image/jpeg',
          kind: 'image',
          label: `page ${r.page}`,
        });
      }
      return ok(
        JSON.stringify({
          pdf_id: a.id,
          pages: rendered.map((r) => r.page),
          note: '画像は次のメッセージに添付(同じ順序)',
        }),
        media,
      );
    },
  };

  return [pdfText, pdfPages];
}
