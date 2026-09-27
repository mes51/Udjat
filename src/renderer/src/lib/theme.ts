export type ThemeSetting = 'system' | 'dark' | 'light';

const mql = window.matchMedia('(prefers-color-scheme: light)');
let current: ThemeSetting = 'system';

function apply(): void {
  const light = current === 'light' || (current === 'system' && mql.matches);
  document.documentElement.dataset['theme'] = light ? 'light' : 'dark';
}

/** テーマ設定を反映する(system の時は OS の変更に追従) */
export function setTheme(theme: ThemeSetting): void {
  current = theme;
  try {
    localStorage.setItem('udjat.theme', theme);
  } catch {
    /* ignore */
  }
  apply();
}

/** 起動時: 前回の設定を localStorage から先に反映しておき、DB の設定が来たら上書きする */
export function initTheme(): void {
  try {
    const saved = localStorage.getItem('udjat.theme') as ThemeSetting | null;
    if (saved === 'system' || saved === 'dark' || saved === 'light') current = saved;
  } catch {
    /* ignore */
  }
  apply();
  mql.addEventListener('change', apply);
}
