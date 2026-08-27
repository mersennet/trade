'use client';
import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { cn } from '@/lib/utils';

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
}

interface ToastContextType {
  toast: (message: string, type?: ToastItem['type']) => void;
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let _id = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastItem['type'] = 'info') => {
    const id = ++_id;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-20 md:bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm">
        {/* Terminal log lines: solid surface, colored left rule, status word. */}
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2.5 px-3.5 py-2.5 text-xs bg-surface border border-border shadow-[0_8px_24px_rgba(0,0,0,0.5)] border-l-2',
              t.type === 'success' && 'border-l-green',
              t.type === 'error' && 'border-l-red',
              t.type === 'info' && 'border-l-primary',
              t.type === 'warning' && 'border-l-yellow',
            )}
          >
            <span className={cn(
              'text-[9px] font-extrabold uppercase tracking-[0.16em] mt-[1.5px] shrink-0',
              t.type === 'success' && 'text-green',
              t.type === 'error' && 'text-red',
              t.type === 'info' && 'text-primary',
              t.type === 'warning' && 'text-yellow',
            )}>
              {t.type === 'success' ? 'OK' : t.type === 'error' ? 'ERR' : t.type === 'warning' ? 'WARN' : 'INFO'}
            </span>
            <span className="text-foreground/90 leading-snug">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
