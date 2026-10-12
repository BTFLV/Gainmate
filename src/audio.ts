import type { Analysis, Settings } from './types';
export const db = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? '−∞' : n.toFixed(digits).replace('-', '−');
export const signed = (n: number) => `${n > 0 ? '+' : ''}${db(n)}`;
export const filename = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
export function prediction(a: Analysis, s: Settings) {
  if (a.integrated == null || a.truePeak == null) return null;
  const wanted = s.target - a.integrated;
  const gain =
    s.mode === 'safe'
      ? Math.min(wanted, s.ceiling - a.truePeak - 0.05)
      : wanted;
  const limiting =
    s.mode === 'precise' ? Math.max(0, a.truePeak + wanted - s.ceiling) : 0;
  return { gain, output: a.integrated + gain, limiting, blocked: limiting > 6 };
}
export function distribution(values: number[]) {
  const bins = Array<number>(32).fill(0);
  for (const v of values) bins[Math.max(0, Math.min(31, Math.floor(v + 36)))]++;
  return bins;
}
export function median(values: number[]) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
