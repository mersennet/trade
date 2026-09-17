'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';
import { startPoll } from '@/lib/poll';

/**
 * Terminal status line — the fixed strip along the bottom of the desktop
 * viewport, straight out of the Bloomberg/vim lineage. Shows the full chain
 * liveness picture (block height, block age, API latency), the WS feed
 * state, and the two real keyboard entry points. Desktop-only: mobile has
 * the bottom tab bar in the same slot.
 */
export default function StatusLine() {
  const { connected } = useWebSocket();
  const [block, setBlock] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [lastBlockAt, setLastBlockAt] = useState<number | null>(null);
  const [ageSec, setAgeSec] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    let lastBlock = 0;
    const tick = async () => {
      const t0 = performance.now();
      try {
        const s = await api.getChainHealth();
        if (!mounted) return;
        setLatencyMs(Math.round(performance.now() - t0));
        if (s.head && s.head !== lastBlock) {
          lastBlock = s.head;
          setBlock(s.head);
          setLastBlockAt(Date.now());
        }
      } catch { /* keep last good values */ }
    };
    tick();
    const stopPoll = startPoll(tick, 5000);
    return () => { mounted = false; stopPoll(); };
  }, []);

  useEffect(() => {
    if (!lastBlockAt) return;
    const t = setInterval(() => setAgeSec(Math.floor((Date.now() - lastBlockAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [lastBlockAt]);

  const healthy = ageSec == null || ageSec < 10;

  return (
    <div className="hidden md:flex fixed bottom-0 left-0 right-0 h-6 z-40 items-center gap-5 px-3 bg-surface border-t border-border text-[10px] tracking-[0.06em] text-dim select-none">
      <a
        href="https://explorer.mersennet.com"
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center gap-1.5 transition-colors ${healthy ? 'text-green' : 'text-yellow'} hover:text-primary-bright`}
        title="Live Mersennet chain status — opens the explorer"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${healthy ? 'bg-green animate-pulse' : 'bg-yellow'}`} />
        {block > 0 ? `BLOCK ${block.toLocaleString()}` : 'CHAIN …'}
        {ageSec != null && <span className="text-dim">· {ageSec}S</span>}
      </a>
      <span className={connected ? 'text-dim' : 'text-yellow'}>
        {connected ? 'WS LIVE' : 'WS RECONNECTING'}
        {latencyMs != null && connected && ` · ${latencyMs}MS`}
      </span>
      <span className="ml-auto flex items-center gap-4">
        <span className="flex items-center gap-1.5"><kbd className="text-[9px] leading-[14px]">⌘K</kbd> COMMANDS</span>
        <span className="flex items-center gap-1.5"><kbd className="text-[9px] leading-[14px] px-[5px]">?</kbd> SHORTCUTS</span>
      </span>
    </div>
  );
}
