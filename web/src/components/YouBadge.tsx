/** Marks the connected wallet's own row in a list of addresses. */
export default function YouBadge() {
  return (
    <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-px text-[9.5px] font-sans font-semibold uppercase tracking-wider text-primary bg-primary/10 ring-1 ring-primary/25">
      you
    </span>
  );
}

export function isSameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
