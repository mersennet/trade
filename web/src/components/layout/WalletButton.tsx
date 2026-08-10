'use client';
import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { MERSENNET_TESTNET } from '@/lib/chain';
import { useStore } from '@/stores/useStore';
import { useToast } from '@/components/shared/Toast';
import { api } from '@/lib/api';
import { shortenAddress, formatNumber } from '@/lib/utils';
import { useDismissable } from '@/hooks/useDismissable';

export default function WalletButton() {
  const { address, balance, provider, isConnected, connect, connectWalletConnect, connectWithEmail, disconnect } = useWallet();
  const setWallet = useStore((s) => s.setWallet);
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [collateral, setCollateral] = useState<number>(0);
  const [usdcBalance, setUsdcBalance] = useState<number>(0);
  const [showEmailLogin, setShowEmailLogin] = useState(false);
  const [showConnectMenu, setShowConnectMenu] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [email, setEmail] = useState('');
  const connectMenuRef = useDismissable<HTMLDivElement>(showConnectMenu, () => setShowConnectMenu(false));
  const accountMenuRef = useDismissable<HTMLDivElement>(showAccountMenu, () => setShowAccountMenu(false));
  const emailRef = useDismissable<HTMLDivElement>(showEmailLogin, () => setShowEmailLogin(false));

  const refreshTokens = useCallback(async () => {
    if (!address || !provider) { setUsdcBalance(0); return; }
    try {
      const { ethers } = await import('ethers');
      type EthersLike = typeof import('ethers');
      const e = ethers as EthersLike;
      // Native MRSN balance, read from the Mersennet RPC directly so it is
      // correct regardless of which chain the wallet provider is pointed at.
      const rpc = new e.providers.JsonRpcProvider(MERSENNET_TESTNET.rpcUrls[0]);
      const bal = await rpc.getBalance(address);
      setUsdcBalance(Number(e.utils.formatEther(bal)));
      // Keep the store copy fresh too — the header chip and account panel
      // read wallet.balance, which was previously only set once at connect.
      setWallet({ balance: bal.toString() });
    } catch {
      // ignore
    }
  }, [address, provider, setWallet]);

  useEffect(() => {
    if (!isConnected || !address) { setCollateral(0); setUsdcBalance(0); return; }
    api.getCollateral(address)
      .then((r) => {
        const val = Number(r.collateral) || 0;
        setCollateral(val);
        setWallet({ collateral: val.toString() });
      })
      .catch(() => {});
    refreshTokens();

    const interval = setInterval(() => {
      api.getCollateral(address)
        .then((r) => {
          const val = Number(r.collateral) || 0;
          setCollateral(val);
          setWallet({ collateral: val.toString() });
        })
        .catch(() => {});
      refreshTokens();
    }, 10000);
    return () => clearInterval(interval);
  }, [address, isConnected, setWallet, refreshTokens]);

  const handleConnect = async (method: 'injected' | 'walletconnect') => {
    setShowConnectMenu(false);
    setLoading(true);
    try {
      if (method === 'walletconnect') await connectWalletConnect();
      else await connect();
    } catch (e) {
      const msg = (e as Error)?.message || '';
      // The WC modal throws when the user just closes it — not an error worth toasting.
      if (/connection request reset|user rejected|modal closed/i.test(msg)) return;
      toast(
        /no (injected )?(ethereum|wallet)|metamask|window\.ethereum/i.test(msg)
          ? 'No browser wallet found. Install MetaMask, or use WalletConnect to link a mobile wallet.'
          : `Connection failed: ${msg.replace(/^Error: /, '') || 'unknown error'}`,
        'error',
      );
    } finally {
      setLoading(false);
    }
  };

  // provider.getBalance returns the wallet's native MRSN balance (18 decimals).
  const nativeBalance = Number(balance || '0') / 1e18;

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="hidden md:flex items-center gap-3 px-3 py-1.5 bg-surface-2 rounded-lg border border-border text-[11px]">
          <div className="flex items-center gap-1.5" title="Native MRSN, used for gas">
            <span className="text-dim">MRSN</span>
            <span className={`font-mono font-medium ${nativeBalance < 1 ? 'text-yellow' : 'text-foreground'}`}>
              {formatNumber(nativeBalance, nativeBalance >= 1 ? 2 : 4)}
            </span>
          </div>
          <div className="w-px h-3.5 bg-border" />
          {collateral > 0 && (
            <>
              <div className="w-px h-3.5 bg-border" />
              <div className="flex items-center gap-1.5" title="MRSN deposited as trading collateral">
                <span className="text-dim">Margin</span>
                <span className="font-mono font-medium text-green">{formatNumber(collateral, 2)} MRSN</span>
              </div>
            </>
          )}
        </div>
        <div className="relative" ref={accountMenuRef}>
          <button
            onClick={() => setShowAccountMenu(!showAccountMenu)}
            aria-expanded={showAccountMenu}
            aria-label="Account menu"
            className="px-2.5 md:px-3 py-1.5 md:py-2 bg-surface-2 rounded-lg border border-border text-[11px] md:text-xs font-mono text-foreground hover:border-primary/40 transition-colors"
          >
            {shortenAddress(address)}
          </button>
          {showAccountMenu && (
            <div className="absolute right-0 top-full mt-1 w-52 bg-surface border border-border rounded-xl p-1.5 shadow-xl z-50">
              <button
                onClick={async () => {
                  setShowAccountMenu(false);
                  // Sub-account switch: ask the wallet for a different account
                  // (MetaMask opens its account picker). The accountsChanged
                  // listener in useWallet completes the switch.
                  try {
                    const w = window.ethereum;
                    if (!w) return;
                    try {
                      await w.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
                    } catch {
                      await w.request({ method: 'eth_requestAccounts' });
                    }
                  } catch { /* user closed the picker */ }
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs text-foreground hover:bg-surface-2 transition-colors"
              >
                <span className="text-base leading-none">⇄</span>
                <span>
                  <span className="block font-medium">Switch account</span>
                  <span className="block text-[10px] text-dim">Pick another wallet account (sub-account)</span>
                </span>
              </button>
              <button
                onClick={() => { setShowAccountMenu(false); disconnect(); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs text-red hover:bg-red/10 transition-colors"
              >
                <span className="text-base leading-none">⏻</span>
                <span className="font-medium">Disconnect</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const handleEmailLogin = async () => {
    if (!email) return;
    setLoading(true);
    try {
      await connectWithEmail(email);
      setShowEmailLogin(false);
      setEmail('');
    } catch (e) {
      toast((e as Error)?.message || 'Email login is unavailable', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative" ref={connectMenuRef}>
        <button
          onClick={() => setShowConnectMenu(!showConnectMenu)}
          disabled={loading}
          className="px-4 md:px-5 h-8 premium-gradient text-black rounded-lg text-[11.5px] font-semibold transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Connecting…' : 'Connect Wallet'}
        </button>
        {showConnectMenu && !loading && (
          <div className="absolute right-0 top-full mt-1 w-56 bg-surface border border-border rounded-xl p-1.5 shadow-xl z-50">
            <button
              onClick={() => handleConnect('injected')}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs text-foreground hover:bg-surface-2 transition-colors"
            >
              <span className="text-base leading-none">🦊</span>
              <span>
                <span className="block font-medium">Browser wallet</span>
                <span className="block text-[10px] text-dim">MetaMask or any injected wallet</span>
              </span>
            </button>
            <button
              onClick={() => handleConnect('walletconnect')}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs text-foreground hover:bg-surface-2 transition-colors"
            >
              <span className="text-base leading-none">🔗</span>
              <span>
                <span className="block font-medium">WalletConnect</span>
                <span className="block text-[10px] text-dim">Scan a QR with a mobile wallet</span>
              </span>
            </button>
          </div>
        )}
      </div>
      <div className="relative" ref={emailRef}>
        <button
          onClick={() => setShowEmailLogin(!showEmailLogin)}
          className="px-2.5 h-8 bg-surface-2 rounded-lg border border-border text-[11.5px] text-dim hover:text-foreground transition-colors"
        >Email</button>
        {showEmailLogin && (
          <div className="absolute right-0 top-full mt-1 w-64 bg-surface border border-border rounded-xl p-3 shadow-xl z-50">
            <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-2">Continue with Email</p>
            <p className="text-[11px] text-dim mb-2">Email sign-in is coming soon. For now, connect a browser wallet to trade.</p>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" disabled
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-xs text-foreground outline-none focus:border-primary/40 mb-2 opacity-50 cursor-not-allowed" />
            <button onClick={handleEmailLogin} disabled
              className="w-full py-2 bg-primary/40 text-white rounded-lg text-xs font-medium opacity-50 cursor-not-allowed transition-all">
              Coming soon
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
