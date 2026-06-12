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
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'px-4 py-3 rounded-lg text-xs font-medium shadow-lg backdrop-blur-xl border',
              t.type === 'success' && 'bg-green/10 text-green border-green/20 shadow-[0_0_16px_rgba(52,211,153,0.1)]',
              t.type === 'error' && 'bg-red/10 text-red border-red/20 shadow-[0_0_16px_rgba(255,82,64,0.12)]',
              t.type === 'info' && 'bg-primary/10 text-primary border-primary/20 shadow-[0_0_16px_rgba(125,255,155,0.1)]',
              t.type === 'warning' && 'bg-yellow/10 text-yellow border-yellow/20 shadow-[0_0_16px_rgba(255,154,60,0.1)]',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
