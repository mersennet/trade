import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatNumber(n: number, decimals = 2): string {
  // A missing or broken value is shown as "—", never as a fake zero.
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(decimals) + 'K';
  return n.toFixed(decimals);
}

/**
 * Points are exact whole numbers with separators (5,500 · 182,523), never
 * compacted: tier thresholds are round numbers, and a rounded "6K" next to a
 * rounded "5K more" does not add up to 10,000. Floored, so a total never reads
 * as the next tier's threshold before the tier is actually reached.
 */
export function formatPoints(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.floor(n).toLocaleString('en-US');
}

export function formatUsd(n: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return '$' + formatNumber(n);
}

export function formatPrice(n: number): string {
  if (n == null || isNaN(n)) return '—';
  if (n === 0) return '—';
  if (n >= 100000) return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (n >= 10000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export function formatPct(n: number): string {
  if (isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

export function shortenAddress(addr: string, chars = 4): string {
  if (!addr) return '';
  return addr.slice(0, chars + 2) + '...' + addr.slice(-chars);
}

export function formatTimeAgo(date: string | Date): string {
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

export const MARKETS = [
  { id: 1, symbol: 'MRSN/USD', base: 'MRSN', quote: 'USD' },
  { id: 2, symbol: 'BTC/USD', base: 'BTC', quote: 'USD' },
  { id: 3, symbol: 'ETH/USD', base: 'ETH', quote: 'USD' },
  { id: 4, symbol: 'SOL/USD', base: 'SOL', quote: 'USD' },
  { id: 5, symbol: 'ARB/USD', base: 'ARB', quote: 'USD' },
];
