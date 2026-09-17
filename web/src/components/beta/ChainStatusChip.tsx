'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { startPoll } from '@/lib/poll';

/**
 * Live chain status chip for the footer: block height + measured API latency
 * + block cadence. On-chain CLOB transparency is a differentiator — Lighter
 * shows the block height in its header; we show the full liveness picture.
 */
export default function ChainStatusChip() {
  const [block, setBlock] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [blockAgeMs, setBlockAgeMs] = useState<number | null>(null);
  const [lastBlockAt, setLastBlockAt] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      const t0 = performance.now();
      try {
        const s = await api.getChainHealth();
        if (!mounted) return;
        const ms = Math.round(performance.now() - t0);
        setLatencyMs(ms);
        if (s.head && s.head !== block) {
          const now = Date.now();
          setLastBlockAt(now);
          setBlock(s.head);
          setBlockAgeMs(0);
        }
      } catch { /* keep last good */ }
    };
    tick();
    const stopPoll = startPoll(tick, 5000);
    const age = setInterval(() => {
      if (lastBlockAt) setBlockAgeMs(Date.now() - lastBlockAt);
    }, 1000);
    return () => { mounted = false; stopPoll(); clearInterval(age); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block, lastBlockAt]);

  if (!block) return null;
  const ageSec = blockAgeMs != null ? Math.floor(blockAgeMs / 1000) : null;
  const healthy = ageSec != null && ageSec < 10;

  return (
    <a
      href="https://explorer.mersennet.com"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-surface-2 border border-border text-[10px] font-mono text-dim hover:text-foreground transition-colors"
      title="Live Mersennet chain status: latest block, seconds since last block, and API round-trip latency"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${healthy ? 'bg-green animate-pulse' : 'bg-yellow'}`} />
      <span>Block {block.toLocaleString()}</span>
      {ageSec != null && <span className="text-dim/70">· {ageSec}s ago</span>}
      {latencyMs != null && <span className="text-dim/70">· {latencyMs}ms</span>}
    </a>
  );
}
