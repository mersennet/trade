'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { api, type ApiKey } from '@/lib/api';
import { cn } from '@/lib/utils';
import { agentStatus, enableAgent, disableAgent, topUpAgentGas, loadAgent, AGENT_GAS_LOW_MRSN, AGENT_GAS_TOPUP_MRSN, type AgentStatus } from '@/lib/agent';

const SLIPPAGE_PRESETS = [0.1, 0.5, 1.0, 2.0];

/** API key management: list / create / revoke scoped keys for the connected
 * wallet. The raw key is shown exactly once at creation (only its hash is
 * stored server-side). */
function ApiKeysSection() {
  const { address, isConnected } = useWallet();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    if (!address) return;
    api.getApiKeys(address).then((r) => setKeys(r.keys || [])).catch(() => {});
  };
  useEffect(refresh, [address]);

  if (!isConnected) {
    return (
      <div className="space-y-3">
        <h3 className="text-xs font-medium text-foreground">API Keys</h3>
        <p className="text-[10px] text-dim">Connect a wallet to manage API keys for bots and scripts.</p>
      </div>
    );
  }

  const create = async () => {
    if (!address || busy) return;
    setBusy(true);
    try {
      const r = await api.createApiKey(address, label || undefined);
      setNewKey(r.key);
      setLabel('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    await api.deleteApiKey(id).catch(() => {});
    refresh();
  };

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-foreground">API Keys</h3>
      {newKey && (
        <div className="p-2.5 bg-green/5 border border-green/25 rounded-lg">
          <p className="text-[10px] text-green font-medium mb-1.5">Key created — copy it now, it won&apos;t be shown again</p>
          <div className="flex items-center gap-1.5">
            <code className="flex-1 text-[10px] font-mono text-foreground bg-surface-2 rounded px-2 py-1.5 truncate">{newKey}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(newKey); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="px-2 py-1.5 text-[10px] font-medium text-primary hover:underline shrink-0"
            >{copied ? 'Copied' : 'Copy'}</button>
            <button onClick={() => setNewKey(null)} aria-label="Dismiss new key" className="text-dim hover:text-foreground text-xs px-1 shrink-0">×</button>
          </div>
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. market-maker bot)"
          aria-label="New API key label"
          className="flex-1 bg-surface-2 border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-foreground outline-none focus:border-primary/40"
        />
        <button
          onClick={create}
          disabled={busy}
          className="px-3 py-1.5 bg-primary/10 text-primary border border-primary/25 rounded-lg text-[11px] font-semibold hover:bg-primary/20 disabled:opacity-40 transition-colors"
        >Create</button>
      </div>
      {keys.length > 0 ? (
        <div className="space-y-1">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between text-[11px] py-1">
              <div className="min-w-0">
                <span className="text-foreground font-medium">{k.label || 'Untitled'}</span>
                <span className="text-dim ml-2 font-mono text-[9.5px]">
                  {(k.permissions || []).join(', ')} · {k.active ? 'active' : 'revoked'}
                </span>
              </div>
              {k.active && (
                <button onClick={() => revoke(k.id)} className="text-[10px] text-dim hover:text-red transition-colors shrink-0 ml-2">Revoke</button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-dim">No keys yet. Keys authenticate the REST API with read/trade scope.</p>
      )}
    </div>
  );
}

export default function SettingsModal() {
  const {
    showSettings, setShowSettings,
    slippage, setSlippage,
    soundEnabled, setSoundEnabled,
    skipConfirm, setSkipConfirm,
    deadManEnabled, setDeadMan,
    theme, setTheme,
  } = useStore();

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSettings) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSettings(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showSettings, setShowSettings]);

  if (!showSettings) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowSettings(false)}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 id="settings-modal-title" className="text-sm font-semibold text-foreground">Settings</h2>
          <button onClick={() => setShowSettings(false)} aria-label="Close settings" className="text-dim hover:text-foreground transition-colors p-1 rounded-lg hover:bg-surface-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Slippage Tolerance */}
          <div>
            <label className="text-xs font-medium text-foreground mb-2 block">Slippage Tolerance</label>
            <div className="flex items-center gap-2">
              {SLIPPAGE_PRESETS.map((v) => (
                <button
                  key={v}
                  onClick={() => setSlippage(v)}
                  className={cn(
                    'flex-1 py-2 text-xs font-medium rounded-lg transition-all',
                    slippage === v
                      ? 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_rgba(43,217,106,0.25)]'
                      : 'bg-surface-2 text-dim hover:text-muted'
                  )}
                >{v}%</button>
              ))}
              <div className="relative flex-1">
                <input
                  type="number"
                  value={slippage}
                  onChange={(e) => setSlippage(Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)))}
                  className="w-full bg-surface-2 border border-border rounded-lg px-2 py-2 text-xs text-foreground font-mono text-right pr-6 outline-none focus:border-primary/40"
                  step="0.1"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-dim">%</span>
              </div>
            </div>
            {slippage > 5 && (
              <p className="text-[10px] text-yellow mt-1.5 flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                High slippage may result in unfavorable fills
              </p>
            )}
          </div>

          <div className="h-px bg-border" />

          {/* Trading Options */}
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-foreground">Trading</h3>
            <OneClickSection />
            <ToggleRow
              label="Skip Order Confirmation"
              description="Don't show confirm dialog before placing orders"
              checked={skipConfirm}
              onChange={setSkipConfirm}
            />
            <ToggleRow
              label="Dead Man's Switch"
              description="Auto-cancel server-side trigger orders when you leave. On-chain resting orders stay on the book — cancel those from Open Orders."
              checked={deadManEnabled}
              onChange={setDeadMan}
            />
          </div>

          <div className="h-px bg-border" />

          {/* Alerts */}
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-foreground">Alerts & Sounds</h3>
            <ToggleRow
              label="Sound Alerts"
              description="Play sound on order fill, cancel, and liquidation"
              checked={soundEnabled}
              onChange={setSoundEnabled}
            />
          </div>

          <div className="h-px bg-border" />

          {/* API keys — scoped keys for programmatic access (bots, scripts).
              The raw key is shown once at creation; only its hash is stored. */}
          <ApiKeysSection />

          <div className="h-px bg-border" />

          {/* Appearance */}
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-foreground">Appearance</h3>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] text-foreground block">Theme</span>
                <span className="text-[10px] text-dim">{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
              </div>
              <div className="flex gap-0.5 p-0.5 bg-surface-2 rounded-lg">
                <button onClick={() => setTheme('dark')} className={cn(
                  'px-3 py-1.5 text-[11px] font-medium rounded-md transition-all',
                  theme === 'dark' ? 'bg-primary/10 text-primary' : 'text-dim hover:text-muted'
                )}>Dark</button>
                <button onClick={() => setTheme('light')} className={cn(
                  'px-3 py-1.5 text-[11px] font-medium rounded-md transition-all',
                  theme === 'light' ? 'bg-primary/10 text-primary' : 'text-dim hover:text-muted'
                )}>Light</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One-click trading = an agent key. Enabling grants the key on-chain (one
 * confirmation), funds it with gas (a second one), then orders, brackets and
 * conditional orders sign silently while positions stay on the main wallet.
 */
function OneClickSection() {
  const { address, provider, isConnected } = useWallet();
  const { oneClickEnabled, setOneClick, setSessionKey } = useStore();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rec = address ? loadAgent(address) : null;

  const refresh = async () => {
    if (!address) { setStatus(null); return; }
    try {
      const st = await agentStatus(address);
      setStatus(st);
      const r = loadAgent(address);
      // The toggle is only "on" when the grant is live on-chain and the key is here.
      const live = st.active && st.granted && !!r;
      setSessionKey(live ? r!.key : null);
      setOneClick(live);
    } catch { /* rpc hiccup */ }
  };
  useEffect(() => {
    const t = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const enable = async () => {
    if (!address || !provider) return;
    setBusy('enable'); setError(null);
    try {
      await enableAgent(provider, address, setStep);
      await refresh();
    } catch (e) {
      const msg = (e as Error).message || 'failed';
      setError(/user (rejected|denied)/i.test(msg) ? 'Cancelled in wallet.' : msg.slice(0, 200));
    } finally { setBusy(null); setStep(null); }
  };
  const disable = async () => {
    if (!address || !provider) return;
    setBusy('disable'); setError(null);
    try { await disableAgent(provider, address); setSessionKey(null); setOneClick(false); await refresh(); }
    catch (e) { setError((e as Error).message?.slice(0, 200) || 'failed'); }
    finally { setBusy(null); }
  };
  const topUp = async () => {
    if (!address || !provider) return;
    setBusy('gas'); setError(null);
    try { await topUpAgentGas(provider, address); await refresh(); }
    catch (e) { setError((e as Error).message?.slice(0, 200) || 'failed'); }
    finally { setBusy(null); }
  };

  const blocksLeft = status?.expiresAtBlock ? Math.max(0, status.expiresAtBlock - status.height) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-[11px] text-foreground block">One-Click Trading (agent key)</span>
          <span className="text-[10px] text-dim">
            A key kept in this browser signs orders, TP/SL and conditional orders without a wallet popup. It can trade for your account, never withdraw from it.
          </span>
        </div>
        {isConnected && status?.active && (
          oneClickEnabled
            ? <button onClick={disable} disabled={!!busy} className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider border border-border rounded-md text-dim hover:text-red hover:border-red/40 shrink-0">{busy === 'disable' ? 'Revoking…' : 'Revoke'}</button>
            : <button onClick={enable} disabled={!!busy} className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider bg-primary text-[#02120a] rounded-md shrink-0">{busy === 'enable' ? 'Setting up…' : 'Enable'}</button>
        )}
      </div>
      {!isConnected && <p className="text-[10px] text-dim">Connect a wallet to set up one-click trading.</p>}
      {isConnected && status && !status.active && (
        <p className="text-[10px] text-dim">Activates at block {status.agentDelegationHeight ? status.agentDelegationHeight.toLocaleString() : '—'} (now {status.height.toLocaleString()}).</p>
      )}
      {step && <p className="text-[10px] text-primary">{step}</p>}
      {error && <p className="text-[10px] text-red">{error}</p>}
      {isConnected && oneClickEnabled && rec && status && (
        <div className="text-[10px] text-dim font-mono flex flex-wrap gap-x-3 gap-y-0.5">
          <span>agent {rec.address.slice(0, 8)}…{rec.address.slice(-4)}</span>
          <span>gas {status.gasMrsn === null ? '—' : status.gasMrsn.toFixed(3)} MRSN{status.gasMrsn !== null && status.gasMrsn < AGENT_GAS_LOW_MRSN ? ' (low)' : ''}</span>
          <span>expires in ~{Math.round(blocksLeft * 2 / 3600)} h</span>
          <button onClick={topUp} disabled={!!busy} className="text-primary hover:underline">{busy === 'gas' ? 'sending…' : `top up ${AGENT_GAS_TOPUP_MRSN} MRSN gas`}</button>
        </div>
      )}
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-[11px] text-foreground block">{label}</span>
        <span className="text-[10px] text-dim">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'w-9 h-5 rounded-full transition-all duration-200 relative shrink-0',
          checked ? 'bg-primary' : 'bg-surface-3 border border-border'
        )}
      >
        <div className={cn(
          'w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200 absolute top-[3px]',
          checked ? 'left-[18px]' : 'left-[3px]'
        )} />
      </button>
    </div>
  );
}
