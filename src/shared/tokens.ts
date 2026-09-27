/**
 * トークン数の粗い推定(main / renderer 共用)。
 * 正確な値はサーバーの usage から取り、これは usage が無い部分(送信前の下書き、ツール結果の追加分)の見積もりに使う。
 * CJK は 1 文字 ≒ 1 トークン、それ以外は 4 文字 ≒ 1 トークンとみなす。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x3000 && c <= 0x9fff) || // CJK 記号・かな・漢字
      (c >= 0xac00 && c <= 0xd7af) || // ハングル
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef) || // 全角英数
      (c >= 0x20000 && c <= 0x2ffff)
    )
      cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 画像 1 枚あたりの目安(長辺 1568px に縮小して送る前提) */
export const IMAGE_TOKENS = 1000;
