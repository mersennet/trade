'use client';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * The terminal's button. Four intents, three sizes; every CTA outside the
 * order ticket should be one of these so labels, heights and focus rings
 * match across pages (before this, each page rolled its own classes).
 *
 *   primary   — the one action on a page (Connect, Deposit, Enter)
 *   secondary — neutral bordered action (Cancel, Details)
 *   ghost     — text-only inline action
 *   danger    — destructive / red side (Withdraw all, Close position)
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'premium-gradient text-black font-semibold hover:brightness-110',
  secondary: 'bg-surface-2 text-foreground border border-border hover:border-primary/40',
  ghost: 'text-primary hover:text-primary-hover underline-offset-2 hover:underline bg-transparent',
  danger: 'bg-red/10 text-red border border-red/30 hover:bg-red/20',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[10.5px]',
  md: 'h-9 px-4 text-[11.5px]',
  lg: 'h-11 px-5 text-[12px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, block = false, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg whitespace-nowrap transition-all select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100',
        VARIANT[variant], SIZE[size], block && 'w-full', className,
      )}
      {...rest}
    >
      {loading && (
        <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />
      )}
      {children}
    </button>
  );
});

export default Button;
