import type { Attachment } from '@shared/schemas';
import { invoke } from './ipc';

/** 添付ファイルの URL(main の udjat-media プロトコルが配信する) */
export function mediaUrl(attachmentId: string): string {
  return `udjat-media://attachment/${attachmentId}`;
}

const IMAGE_MAX_EDGE = 1568;

/**
 * 画像を canvas で縮小して JPEG/PNG の base64 にする(EXIF の回転も適用)。
 * 縮小不要ならそのまま base64 化する。
 */
async function encodeImage(file: File): Promise<{ base64: string; mime: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const needsResize = scale < 1 || !['image/jpeg', 'image/png'].includes(file.type);
  if (!needsResize) {
    bitmap.close();
    return { base64: await toBase64(file), mime: file.type };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas を使えません');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, mime, 0.9));
  if (!blob) throw new Error('画像の変換に失敗しました');
  return { base64: await toBase64(blob), mime };
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let s = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function isImage(file: File): boolean {
  return file.type.startsWith('image/');
}

export function isVideo(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.name);
}

/**
 * File を main に登録して Attachment にする。
 * 画像は renderer で縮小してバイト列で送り、それ以外はパスで渡す(大きな動画を IPC に載せない)。
 */
export async function addFile(file: File): Promise<Attachment> {
  if (isImage(file)) {
    const { base64, mime } = await encodeImage(file);
    return invoke('attachments:addBytes', { name: file.name || 'image', mime, base64 });
  }
  const path = window.udjat.pathForFile(file);
  if (!path) {
    // 貼り付け等でパスが無い場合はバイト列で送る(サイズ上限あり)
    if (file.size > 50 * 1024 * 1024) throw new Error('パスの無いファイルは 50MB までです');
    return invoke('attachments:addBytes', {
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      base64: await toBase64(file),
    });
  }
  return invoke('attachments:addPath', { path, name: file.name });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatSeconds(ms: number | undefined): string {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}
