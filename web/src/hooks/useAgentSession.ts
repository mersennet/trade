'use client';
import { useEffect } from 'react';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { agentStatus, loadAgent } from '@/lib/agent';

/**
 * Load this browser's agent key for the connected wallet into the store when
 * the on-chain grant is live, so one-click trading, TP/SL and conditional
 * orders sign silently from the first click — without opening Settings.
 * Re-checked every two minutes (grants expire; gas runs out).
 */
export function useAgentSession() {
  const { address } = useWallet();
  const setSessionKey = useStore((s) => s.setSessionKey);
  const setOneClick = useStore((s) => s.setOneClick);
  useEffect(() => {
    if (!address) { setSessionKey(null); setOneClick(false); return; }
    let alive = true;
    const check = async () => {
      try {
        const rec = loadAgent(address);
        if (!rec) { if (alive) { setSessionKey(null); setOneClick(false); } return; }
        const st = await agentStatus(address);
        if (!alive) return;
        const live = st.active && st.granted;
        setSessionKey(live ? rec.key : null);
        setOneClick(live);
      } catch { /* keep the previous state on rpc hiccups */ }
    };
    check();
    const t = setInterval(check, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, [address, setSessionKey, setOneClick]);
}
