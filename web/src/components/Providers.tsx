'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { ToastProvider } from '@/components/shared/Toast';
import CommandPalette from '@/components/shared/CommandPalette';
import ShortcutHelp from '@/components/shared/ShortcutHelp';
import SettingsModal from '@/components/shared/SettingsModal';
import DeadManSwitch from '@/components/shared/DeadManSwitch';
import { useStore } from '@/stores/useStore';
import { captureRefFromUrl } from '@/lib/referral';
import { useAgentSession } from '@/hooks/useAgentSession';
import { installErrorReporter } from '@/lib/errorReporter';

// Load this browser's one-click agent key whenever the connected wallet's
// grant is live — on every page, so closing a position from Portfolio or
// arming a bracket after a hard reload signs silently too.
function AgentSession() {
  useAgentSession();
  return null;
}

function ThemeInit() {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  return null;
}

// Persist any ?ref=<builder_code> on first load so it can be attached to the
// visitor's later orders (the only thing the API credits referrers for).
function ReferralCapture() {
  useEffect(() => {
    captureRefFromUrl();
    installErrorReporter();
  }, []);
  return null;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5000, refetchOnWindowFocus: false },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ThemeInit />
        <ReferralCapture />
        <AgentSession />
        <CommandPalette />
        <ShortcutHelp />
        <SettingsModal />
        <DeadManSwitch />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
