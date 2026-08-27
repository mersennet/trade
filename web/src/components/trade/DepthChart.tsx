'use client';
import { useEffect, useRef, useMemo, useCallback } from 'react';
import { useStore } from '@/stores/useStore';
import { api } from '@/lib/api';
import { formatPrice, formatNumber } from '@/lib/utils';

interface Level { price: number; size: number; cumulative: number; }

export default function DepthChart() {
  const { market, theme } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<{ bids: Level[]; asks: Level[] }>({ bids: [], asks: [] });

  const isDark = theme === 'dark';
  const colors = useMemo(() => ({
    bg: isDark ? '#050507' : '#ffffff',
    bidFill: isDark ? 'rgba(52,211,153,0.12)' : 'rgba(22,163,74,0.12)',
    bidLine: isDark ? '#34d399' : '#16a34a',
    askFill: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(220,38,38,0.12)',
    askLine: isDark ? '#f87171' : '#dc2626',
    grid: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)',
    text: isDark ? '#6e6b7b' : '#71717a',
    midLine: isDark ? 'rgba(43,217,106,0.4)' : 'rgba(15,174,98,0.4)',
  }), [isDark]);

  const fetchData = useCallback(async () => {
    try {
      const { orderbook } = await api.getOrderBook(market.id);
      const rawBids = (orderbook?.bids || []).sort((a: [number, number], b: [number, number]) => b[0] - a[0]);
      const rawAsks = (orderbook?.asks || []).sort((a: [number, number], b: [number, number]) => a[0] - b[0]);

      let cumBid = 0;
      const bids: Level[] = rawBids.map(([p, s]: [number, number]) => {
        cumBid += s;
        return { price: p, size: s, cumulative: cumBid };
      });

      let cumAsk = 0;
      const asks: Level[] = rawAsks.map(([p, s]: [number, number]) => {
        cumAsk += s;
        return { price: p, size: s, cumulative: cumAsk };
      });

      dataRef.current = { bids, asks };
    } catch {}
  }, [market.id]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const { bids, asks } = dataRef.current;

    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    if (bids.length === 0 && asks.length === 0) {
      ctx.fillStyle = colors.text;
      ctx.font = '11px "Schibsted Grotesk", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for order book data...', w / 2, h / 2);
      return;
    }

    const maxCum = Math.max(
      bids.length > 0 ? bids[bids.length - 1].cumulative : 0,
      asks.length > 0 ? asks[asks.length - 1].cumulative : 0,
    );
    if (maxCum === 0) return;

    const allPrices = [...bids.map((b) => b.price), ...asks.map((a) => a.price)];
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const priceRange = maxPrice - minPrice || 1;

    const padX = 48;
    const padY = 24;
    const chartW = w - padX * 2;
    const chartH = h - padY * 2;

    const priceToX = (p: number) => padX + ((p - minPrice) / priceRange) * chartW;
    const cumToY = (c: number) => padY + chartH - (c / maxCum) * chartH;

    // Grid
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padY + (chartH / 4) * i;
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(w - padX, y); ctx.stroke();
      ctx.fillStyle = colors.text;
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(formatNumber(maxCum * (1 - i / 4), 0), padX - 6, y + 3);
    }
    for (let i = 0; i <= 4; i++) {
      const x = padX + (chartW / 4) * i;
      ctx.beginPath(); ctx.moveTo(x, padY); ctx.lineTo(x, h - padY); ctx.stroke();
      const price = minPrice + (priceRange / 4) * i;
      ctx.fillStyle = colors.text;
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(formatPrice(price), x, h - padY + 14);
    }

    // Bids (left side, green)
    if (bids.length > 0) {
      ctx.beginPath();
      ctx.moveTo(priceToX(bids[0].price), cumToY(0));
      for (const b of bids) {
        ctx.lineTo(priceToX(b.price), cumToY(b.cumulative));
      }
      const lastBid = bids[bids.length - 1];
      ctx.lineTo(priceToX(lastBid.price), cumToY(0));
      ctx.closePath();
      ctx.fillStyle = colors.bidFill;
      ctx.fill();
      ctx.strokeStyle = colors.bidLine;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(priceToX(bids[0].price), cumToY(bids[0].cumulative));
      for (let i = 1; i < bids.length; i++) {
        ctx.lineTo(priceToX(bids[i].price), cumToY(bids[i].cumulative));
      }
      ctx.stroke();
    }

    // Asks (right side, red)
    if (asks.length > 0) {
      ctx.beginPath();
      ctx.moveTo(priceToX(asks[0].price), cumToY(0));
      for (const a of asks) {
        ctx.lineTo(priceToX(a.price), cumToY(a.cumulative));
      }
      const lastAsk = asks[asks.length - 1];
      ctx.lineTo(priceToX(lastAsk.price), cumToY(0));
      ctx.closePath();
      ctx.fillStyle = colors.askFill;
      ctx.fill();
      ctx.strokeStyle = colors.askLine;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(priceToX(asks[0].price), cumToY(asks[0].cumulative));
      for (let i = 1; i < asks.length; i++) {
        ctx.lineTo(priceToX(asks[i].price), cumToY(asks[i].cumulative));
      }
      ctx.stroke();
    }

    // Mid price line
    if (bids.length > 0 && asks.length > 0) {
      const mid = (bids[0].price + asks[0].price) / 2;
      const midX = priceToX(mid);
      ctx.strokeStyle = colors.midLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(midX, padY); ctx.lineTo(midX, h - padY); ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = colors.text;
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(formatPrice(mid), midX, padY - 6);
    }
  }, [colors]);

  useEffect(() => {
    // Depth data only refreshes every 3s (fetchData), so a single 500ms repaint
    // is more than enough. The previous code also self-scheduled draw() via
    // requestAnimationFrame, so every interval tick spawned another 60fps loop;
    // now there is exactly one scheduler.
    const interval = setInterval(draw, 500);
    draw();
    return () => clearInterval(interval);
  }, [draw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}
