import type { RegisteredTool } from '../types';
import { ok } from '../types';

/** ローカルモデルは現在日時を知らないので、明示的に取れるようにする */
export const currentDatetimeTool: RegisteredTool = {
  definition: {
    name: 'current_datetime',
    description:
      '現在の日時とタイムゾーンを返す。日付や時刻に関する質問、期限や経過日数の計算の前に呼ぶ。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  source: { kind: 'builtin' },
  defaultPolicy: 'auto',
  execute: async () => {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return ok(
      JSON.stringify({
        iso: now.toISOString(),
        local: now.toLocaleString('ja-JP', { timeZone: tz, hour12: false }),
        timezone: tz,
        weekday: now.toLocaleDateString('ja-JP', { weekday: 'long', timeZone: tz }),
        unix: Math.floor(now.getTime() / 1000),
      }),
    );
  },
};
