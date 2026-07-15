'use client';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '@/stores/useStore';
import { useToast } from '@/components/shared/Toast';
import { cn } from '@/lib/utils';
import {
  getPrivacyStatus,
  viewingKeyFromSeed,
  storeViewingKey,
  loadViewingKey,
  clearViewingKey,
  reconstructShieldedBalances,
  type PrivacyStatus,
  type ViewingKey,
  type ShieldedBalances,
} from '@/lib/shielded';

/** Asset-id labels for the shielded balance panel (asset 0 = native MRSN). */
const ASSET_LABELS: Record<number, string> = { 0: 'MRSN' };

function shortHex(hex: string, lead = 10, tail = 6): string {
  if (!hex || hex.length <= lead + tail + 2) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

const WAD = BigInt('1000000000000000000');

function formatUnits18(value: bigint): string {
  const whole = value / WAD;
  const frac = value % WAD;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

export default function PrivacyPanel() {
  const { toast } = useToast();
  const privateMode = useStore((s) => s.privateMode);
  const setPrivateMode = useStore((s) => s.setPrivateMode);
  const privacyForkActive = useStore((s) => s.privacyForkActive);
  const setPrivacyForkActive = useStore((s) => s.setPrivacyForkActive);

  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [viewingKey, setViewingKey] = useState<ViewingKey | null>(null);
  const [seedInput, setSeedInput] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [balances, setBalances] = useState<ShieldedBalances | null>(null);
  const [scanning, setScanning] = useState(false);

  // Detect the privacy fork on mount and refresh every couple of minutes so
  // the panel flips live the moment the fork activates.
  useEffect(() => {
    let stop = false;
    const probe = async () => {
      try {
        const s = await getPrivacyStatus();
        if (stop) return;
        setStatus(s);
        setPrivacyForkActive(s.active);
      } catch { /* RPC unreachable; keep last status */ }
    };
    probe();
    const t = setInterval(probe, 120_000);
    return () => { stop = true; clearInterval(t); };
  }, [setPrivacyForkActive]);

  useEffect(() => {
    setViewingKey(loadViewingKey());
  }, []);

  const deriveKey = useCallback(() => {
    if (!seedInput.trim()) {
      toast('Enter a seed phrase for your viewing key', 'error');
      return;
    }
    const vk = viewingKeyFromSeed(seedInput.trim());
    storeViewingKey(vk);
    setViewingKey(vk);
    setSeedInput('');
    setShowSetup(false);
    toast('Viewing key derived — kept in this session only', 'success');
  }, [seedInput, toast]);

  const forgetKey = useCallback(() => {
    clearViewingKey();
    setViewingKey(null);
    setBalances(null);
    setPrivateMode(false);
  }, [setPrivateMode]);

  const scanBalances = useCallback(async () => {
    if (!viewingKey) return;
    setScanning(true);
    try {
      // Self-scan uses the wallet's own grant; the grant id is the wallet's
      // self-grant (its view public key doubles as the self-grant handle).
      const result = await reconstructShieldedBalances(viewingKey, viewingKey.viewPk);
      setBalances(result);
    } catch (e) {
      toast(`Shielded scan failed: ${(e as Error).message}`, 'error');
    } finally {
      setScanning(false);
    }
  }, [viewingKey, toast]);

  return (
    <div className="bg-surface border border-border rounded-xl md:border-0 md:rounded-none p-2.5 md:p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span className="text-[12px] font-semibold text-foreground">Privacy</span>
        </div>
        <span
          className={cn(
            'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
            privacyForkActive
              ? 'bg-green/15 text-green'
              : 'bg-surface-2 text-dim border border-border'
          )}
        >
          {privacyForkActive ? 'Shielded pool live' : 'Pre-fork'}
        </span>
      </div>

      {/* Live shielded-state facts (readable pre-fork) */}
      {status && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px]">
          <span className="text-dim">Shielded root</span>
          <span className="text-right font-mono text-muted" title={status.shieldedStateRoot}>
            {shortHex(status.shieldedStateRoot)}
          </span>
          <span className="text-dim">Notes / nullifiers</span>
          <span className="text-right text-muted">{status.noteCount} / {status.nullifierCount}</span>
          {status.proverMode && (
            <>
              <span className="text-dim">Prover</span>
              <span className="text-right text-muted capitalize">{status.proverMode}</span>
            </>
          )}
        </div>
      )}

      {!privacyForkActive ? (
        <p className="text-[10.5px] text-dim leading-relaxed">
          The shielded pool is anchored in every block today. Private trading — hidden
          balances, salted order sides, encrypted intents — switches on at the privacy
          hard fork. This panel activates automatically.
        </p>
      ) : (
        <>
          {/* Viewing key vault */}
          {!viewingKey ? (
            showSetup ? (
              <div className="flex flex-col gap-1.5">
                <input
                  type="password"
                  value={seedInput}
                  onChange={(e) => setSeedInput(e.target.value)}
                  placeholder="Viewing-key seed phrase"
                  className="w-full h-7 px-2 bg-background border border-border rounded-md text-[11px] text-foreground placeholder:text-dim focus:outline-none focus:border-primary/50"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={deriveKey}
                    className="flex-1 h-7 premium-gradient text-black rounded-md text-[11px] font-semibold transition-all hover:brightness-110"
                  >
                    Derive key
                  </button>
                  <button
                    onClick={() => setShowSetup(false)}
                    className="px-2.5 h-7 bg-surface-2 text-dim rounded-md text-[11px] hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                <p className="text-[10px] text-dim">
                  Derived locally, kept in this browser session only. It never leaves your device.
                </p>
              </div>
            ) : (
              <button
                onClick={() => setShowSetup(true)}
                className="w-full h-7 bg-surface-2 border border-border text-foreground rounded-md text-[11px] font-medium hover:border-primary/40 transition-colors"
              >
                Set up viewing key
              </button>
            )
          ) : (
            <>
              {/* Private mode toggle */}
              <label className="flex items-center justify-between cursor-pointer select-none">
                <span className="text-[11px] text-muted">Private mode</span>
                <button
                  role="switch"
                  aria-checked={privateMode}
                  onClick={() => setPrivateMode(!privateMode)}
                  className={cn(
                    'relative w-8 h-[18px] rounded-full transition-colors',
                    privateMode ? 'bg-primary' : 'bg-surface-2 border border-border'
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all',
                      privateMode ? 'left-[16px]' : 'left-[2px]'
                    )}
                  />
                </button>
              </label>
              {privateMode && (
                <p className="text-[10px] text-primary/90">
                  Orders route through the shielded intent lane — side salted, authorship hidden.
                </p>
              )}

              {/* Shielded balances (client-side reconstruction) */}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted">Shielded balances</span>
                <button
                  onClick={scanBalances}
                  disabled={scanning}
                  className="text-[10.5px] text-primary hover:brightness-110 disabled:opacity-50 transition-all"
                >
                  {scanning ? 'Scanning…' : balances ? 'Rescan' : 'Scan notes'}
                </button>
              </div>
              {balances && (
                Object.keys(balances.perAsset).length === 0 ? (
                  <p className="text-[10.5px] text-dim">
                    No unspent notes for this viewing key
                    {balances.spentNoteCount > 0 ? ` (${balances.spentNoteCount} spent)` : ''}.
                  </p>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {Object.entries(balances.perAsset).map(([assetId, value]) => (
                      <div key={assetId} className="flex items-center justify-between text-[11px]">
                        <span className="text-dim">{ASSET_LABELS[Number(assetId)] ?? `Asset #${assetId}`}</span>
                        <span className="font-mono text-foreground">{formatUnits18(value)}</span>
                      </div>
                    ))}
                    <p className="text-[9.5px] text-dim mt-0.5">
                      Reconstructed locally from {balances.unspentNoteCount} unspent notes @ block {balances.blockNumber}.
                    </p>
                  </div>
                )
              )}

              <button
                onClick={forgetKey}
                className="text-[10px] text-dim hover:text-red transition-colors self-start"
              >
                Forget viewing key
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
