// resources/icon.svg から build/icon.png(1024)、build/icon.ico(16〜256)、resources/icon.png(256)を作る。
// アイコンを差し替えたら `node scripts/make-icons.mjs` を実行する。@napi-rs/canvas(依存済み)で SVG をラスタ化する。
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'resources', 'icon.svg'));
const image = await loadImage(svg);

/** 正方形の PNG。周囲に少し余白を取り、元の比率を保って中央に置く */
async function renderPng(size, padRatio = 0.06) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const pad = Math.round(size * padRatio);
  const inner = size - pad * 2;
  const scale = Math.min(inner / image.width, inner / image.height);
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  ctx.drawImage(image, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
  return canvas.toBuffer('image/png');
}

/** PNG 圧縮エントリの ICO(Vista 以降で有効。electron-builder もこの形式を受け付ける) */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.png'), await renderPng(1024));
writeFileSync(join(root, 'resources', 'icon.png'), await renderPng(256));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = [];
for (const size of sizes) entries.push({ size, png: await renderPng(size) });
writeFileSync(join(root, 'build', 'icon.ico'), buildIco(entries));
process.stdout.write(
  `wrote build/icon.png (1024), build/icon.ico ${sizes.join('/')} and resources/icon.png (256)
`,
);
