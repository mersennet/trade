'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PREVIEW_ROUTES } from '@/config/previewRoutes';

/**
 * One banner for every roadmap surface (see config/previewRoutes.ts). Mounted
 * once in the root layout, so a page cannot forget it. Not dismissible: the
 * point is that a screenshot of a preview page always says it is one.
 */
export default function PreviewBanner() {
  const pathname = usePathname();
  const note = pathname ? PREVIEW_ROUTES[pathname] : undefined;
  if (!note) return null;
  return (
    <div
      role="note"
      data-testid="preview-banner"
      className="mx-3 mt-3 md:mx-6 md:mt-4 rounded-lg border border-yellow/40 bg-yellow/[0.06] px-3.5 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1"
    >
      <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-yellow/40 bg-yellow/10 text-yellow text-[9px] font-mono font-bold uppercase tracking-[0.18em]">
        Preview
      </span>
      <span className="text-[12px] text-foreground/85 leading-relaxed">
        This page is a roadmap preview and is not part of the live testnet. {note}
      </span>
      <Link href="/trade" className="text-[12px] text-primary hover:text-primary-hover underline ml-auto">
        Back to the live terminal
      </Link>
    </div>
  );
}
