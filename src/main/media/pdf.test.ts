import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfService } from './pdf';
import { minimalPdf } from './test-fixtures';

let dir: string;
let file: string;
const svc = new PdfService();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-pdf-'));
  file = join(dir, 'doc.pdf');
  writeFileSync(file, minimalPdf([['Hello Udjat', 'Second line'], ['Page two text']]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('PdfService', () => {
  it('reports page count and extracts text per page', async () => {
    expect((await svc.info(file)).numPages).toBe(2);
    const r = await svc.extractText(file);
    expect(r.numPages).toBe(2);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(r.pages[0]!.text).toContain('Hello Udjat');
    expect(r.pages[0]!.text).toContain('Second line');
    expect(r.pages[1]!.text).toContain('Page two text');
    const partial = await svc.extractText(file, 2, 2);
    expect(partial.pages.map((p) => p.page)).toEqual([2]);
  }, 30_000);

  it('renders pages to JPEG at the requested width', async () => {
    const imgs = await svc.renderPages(file, [2, 99], { width: 300 });
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({ page: 2, width: 300 });
    expect(imgs[0]!.height).toBeGreaterThan(300);
    expect(imgs[0]!.jpeg.length).toBeGreaterThan(1000);
    expect(imgs[0]!.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG マジック
  }, 30_000);
});
