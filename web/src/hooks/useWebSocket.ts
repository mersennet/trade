'use client';
import { useEffect, useRef, useCallback, useState } from 'react';
import { createWsConnection } from '@/lib/api';

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());

  const subscribe = useCallback((channel: string, handler: (data: unknown) => void) => {
    if (!handlersRef.current.has(channel)) {
      handlersRef.current.set(channel, new Set());
    }
    handlersRef.current.get(channel)!.add(handler);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'subscribe', channel }));
    }

    return () => {
      handlersRef.current.get(channel)?.delete(handler);
      if (handlersRef.current.get(channel)?.size === 0) {
        handlersRef.current.delete(channel);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ action: 'unsubscribe', channel }));
        }
      }
    };
  }, []);

  useEffect(() => {
    // Guard against the cleanup path: ws.close() fires onclose, which would
    // otherwise schedule a reconnect for an unmounted hook (zombie socket).
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    function connect() {
      if (disposed) return;
      const ws = createWsConnection();
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
        for (const channel of handlersRef.current.keys()) {
          ws.send(JSON.stringify({ action: 'subscribe', channel }));
        }
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'ticker') {
            handlersRef.current.get(`ticker:${data.marketId}`)?.forEach((h) => h(data));
          } else if (data.type === 'orderbook') {
            handlersRef.current.get(`orderbook:${data.marketId}`)?.forEach((h) => h(data));
          } else if (data.type === 'trade') {
            handlersRef.current.get(`trades:${data.marketId}`)?.forEach((h) => h(data));
          } else if (data.type === 'newBlock') {
            handlersRef.current.get('blocks')?.forEach((h) => h(data));
          }
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        // Capped exponential backoff: 1s, 2s, 4s … up to 30s.
        const delay = Math.min(1000 * 2 ** attempts, 30000);
        attempts += 1;
        retryTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  return { connected, subscribe };
}
