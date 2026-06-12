'use client';
import { cn } from '@/lib/utils';

/**
 * Deterministic address avatar — derives a unique gradient + initials
 * from the user's wallet address. Replaces the "PR" placeholder badges
 * we had on leaderboard, whales, and trader profile rows.
 */
export default function AddressAvatar({
  address,
  size = 24,
  className,
}: {
  address: string;
  size?: number;
  className?: string;
}) {
  const hex = address.toLowerCase().replace(/^0x/, '').padEnd(8, '0');
  const h1 = parseInt(hex.slice(0, 3), 16) % 360;
  const h2 = (h1 + 60 + (parseInt(hex.slice(3, 6), 16) % 90)) % 360;
  const initials = address.slice(2, 4).toUpperCase();

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-mono font-bold text-white select-none', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, size * 0.38),
        background: `linear-gradient(135deg, hsl(${h1}, 65%, 50%), hsl(${h2}, 70%, 40%))`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
