'use client';
import { cn } from '@/lib/utils';

interface TokenLogoProps {
  symbol: string;
  size?: number;
  className?: string;
}

/**
 * Inline SVG token logos for the 5 markets currently listed on Mersennet Trade.
 * Bundled locally so they:
 *  - never 404 from a third-party CDN going down
 *  - stay sharp at any pixel density
 *  - tree-shake to roughly the bytes of the SVGs you actually render.
 *
 * Adding a new market: add a renderer to LOGOS keyed by upper-case symbol.
 * Unknown symbols fall through to a generated initial-letter avatar with a
 * deterministic gradient so two unknowns never look identical.
 */
const LOGOS: Record<string, (size: number) => React.ReactNode> = {
  BTC: (s) => (
    <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="#F7931A" />
      <path
        d="M21.7 14.4c.3-2-1.2-3-3.3-3.7l.7-2.7-1.6-.4-.7 2.6c-.4-.1-.9-.2-1.3-.3l.7-2.6-1.6-.4-.7 2.7c-.3-.1-.7-.2-1-.3l-2.3-.6-.4 1.7s1.2.3 1.2.3c.7.2.8.6.8 1l-.8 3c.1 0 .1 0 .2.1l-.2 0-1.1 4.3c-.1.2-.3.5-.8.4 0 0-1.2-.3-1.2-.3l-.8 1.9 2.1.5c.4.1.8.2 1.2.3l-.7 2.7 1.6.4.7-2.7c.4.1.9.2 1.3.3l-.7 2.7 1.6.4.7-2.7c2.8.5 4.9.3 5.8-2.2.7-2-.1-3.2-1.5-4 1.1-.2 1.9-1 2.1-2.4zm-3.7 5.3c-.5 2-4 .9-5.1.7l.9-3.6c1.1.3 4.7.8 4.2 2.9zm.5-5.3c-.5 1.9-3.3.9-4.3.7l.8-3.3c1 .2 4 .7 3.5 2.6z"
        fill="#fff"
      />
    </svg>
  ),
  ETH: (s) => (
    <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff" fillRule="nonzero">
        <path d="M16.5 4v8.87l7.497 3.35z" fillOpacity=".602" />
        <path d="M16.5 4L9 16.22l7.5-3.35z" />
        <path d="M16.5 21.97v6.02L24 17.62z" fillOpacity=".602" />
        <path d="M16.5 27.99v-6.03L9 17.62z" />
        <path d="M16.5 20.57l7.497-4.35-7.497-3.35z" fillOpacity=".2" />
        <path d="M9 16.22l7.5 4.35v-7.7z" fillOpacity=".602" />
      </g>
    </svg>
  ),
  SOL: (s) => (
    <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={`sol-grad-${s}`} x1="0" x2="32" y1="0" y2="32">
          <stop offset="0%" stopColor="#9945FF" />
          <stop offset="100%" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill="#0B0B14" />
      <g fill={`url(#sol-grad-${s})`}>
        <path d="M9.7 22.1c.2-.2.5-.3.8-.3h13.1c.4 0 .6.5.3.8l-2 2c-.2.2-.5.3-.8.3H8c-.4 0-.6-.5-.3-.8z" />
        <path d="M9.7 7.4c.2-.2.5-.3.8-.3h13.1c.4 0 .6.5.3.8l-2 2c-.2.2-.5.3-.8.3H8c-.4 0-.6-.5-.3-.8z" />
        <path d="M22.3 14.7c-.2-.2-.5-.3-.8-.3H8.4c-.4 0-.6.5-.3.8l2 2c.2.2.5.3.8.3H24c.4 0 .6-.5.3-.8z" />
      </g>
    </svg>
  ),
  // MRSN / Mersennet mark — same asset used in the sidebar.
  MRSN: (s) => (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img src="/tokens/mrsn.svg" alt="MRSN" width={s} height={s} draggable={false} />
  ),
  // ARB / Arbitrum mark — listed as market 5 on Mersennet Trade.
  ARB: (s) => (
    <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="#2D374B" />
      <path d="M16.7 9.1c-.4-.2-.9-.2-1.4 0l-6.4 3.7c-.4.2-.7.7-.7 1.2v7.4c0 .5.3.9.7 1.2l6.4 3.7c.4.2.9.2 1.4 0l6.4-3.7c.4-.2.7-.7.7-1.2V14c0-.5-.3-.9-.7-1.2z" fill="#2D374B" />
      <path d="M17.6 19.7l-1.1-3-3 5.2 2.9 1.7zm2.4 1.6l-3.3-5.7-1 1.7 2.4 4.1 1.6-.9c.1-.1.2-.2.3-.4z" fill="#28A0F0" />
      <path d="M8.4 22l1.9-1.1-1.9-1.1zm5.3-12.6h-1.6c-.1 0-.2.1-.3.2l-3.6 9.7 1.9 1.1 3.7-10.6c0-.2 0-.4-.1-.4zm2.8 0H15c-.1 0-.2.1-.3.2L10.6 21l1.9 1.1 4.3-12.3c.1-.2 0-.4-.3-.4z" fill="#fff" />
      <path d="M23.6 14c0-.5-.3-.9-.7-1.2l-6.4-3.7c-.2-.1-.4-.1-.6-.1-.2 0-.4 0-.6.1l-6.4 3.7-.1.1 1.7 1 6.4-3.7 5.1 2.9c.1.1.2.2.2.4v6.7l1.7-1z" fill="#96BEDC" />
    </svg>
  ),
  USDC: (s) => (
    <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <path
        d="M20.5 18.5c0-2.4-1.4-3.2-4.3-3.5-2-.3-2.4-.8-2.4-1.7s.7-1.5 2.1-1.5c1.3 0 2 .4 2.3 1.5.1.2.3.4.5.4h1.1c.3 0 .5-.2.5-.5v-.1c-.3-1.5-1.5-2.6-3-2.8V8.7c0-.3-.2-.5-.6-.5h-1c-.3 0-.5.2-.5.5v1.5c-2 .3-3.3 1.6-3.3 3.3 0 2.3 1.4 3.1 4.3 3.5 1.9.3 2.5.7 2.5 1.7s-.9 1.7-2.1 1.7c-1.6 0-2.2-.7-2.4-1.6-.1-.3-.3-.4-.5-.4h-1.2c-.3 0-.5.2-.5.5v.1c.3 1.7 1.4 2.9 3.5 3.2v1.5c0 .3.2.5.6.5h1c.3 0 .5-.2.5-.5v-1.5c2-.3 3.4-1.7 3.4-3.5z"
        fill="#fff"
      />
    </svg>
  ),
};

function gradientFromSymbol(symbol: string): [string, string] {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue}, 65%, 55%)`, `hsl(${(hue + 40) % 360}, 70%, 45%)`];
}

export default function TokenLogo({ symbol, size = 32, className }: TokenLogoProps) {
  const key = symbol.toUpperCase();
  const renderer = LOGOS[key];

  if (renderer) {
    return (
      <span className={cn('inline-flex shrink-0 rounded-full overflow-hidden', className)} style={{ width: size, height: size }}>
        {renderer(size)}
      </span>
    );
  }

  const [from, to] = gradientFromSymbol(key);
  const initial = key.slice(0, 1);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full text-white font-bold', className)}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${from}, ${to})`,
        fontSize: Math.max(10, size * 0.42),
      }}
    >
      {initial}
    </span>
  );
}
