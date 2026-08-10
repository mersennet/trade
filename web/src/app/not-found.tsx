import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-[64px] font-bold font-mono text-primary leading-none">404</p>
      <h1 className="text-lg font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-dim max-w-sm">
        The page you are looking for doesn&apos;t exist or has moved.
      </p>
      <div className="flex gap-2 mt-2">
        <Link
          href="/trade"
          className="px-5 py-2 premium-gradient text-black rounded-lg text-xs font-semibold hover:brightness-110 transition-all"
        >Open the terminal</Link>
        <Link
          href="/"
          className="px-5 py-2 bg-surface-2 border border-border rounded-lg text-xs font-medium text-dim hover:text-foreground transition-colors"
        >Home</Link>
      </div>
    </div>
  );
}
