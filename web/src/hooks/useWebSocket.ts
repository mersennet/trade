'use client';
import { useEffect, useCallback, useState } from 'react';
import { subscribe as hubSubscribe, onStatus } from '@/lib/wsHub';

/** The tab's shared WebSocket (see lib/wsHub): connection state and channel subscriptions. */
export function useWebSocket() {
  const [connected, setConnected] = useState(false);

  useEffect(() => onStatus(setConnected), []);

  const subscribe = useCallback(
    (channel: string, handler: (data: unknown) => void) => hubSubscribe(channel, handler),
    [],
  );

  return { connected, subscribe };
}
