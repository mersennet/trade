'use client';
import { useRef, useEffect, useCallback } from 'react';
import { useStore } from '@/stores/useStore';
import { api } from '@/lib/api';

export default function DepthHeatmap() {
  const { market, theme } = useStore();
  const isDark = theme === 'dark';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<{ bids: [number, number][]; asks: [number, number][] }>({ bids: [], asks: [] });

  const fetchData = useCallback(async () => {
    try {
      const { orderbook } = await api.getOrderBook(market.id);
      dataRef.current = { bids: orderbook.bids, asks: orderbook.asks };
    } catch {}
  }, [market.id]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const { bids, asks } = dataRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (bids.length === 0 && asks.length === 0) {
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.30)';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('No depth data', w / 2, h / 2);
      return;
    }

    const sortedBids = [...bids].sort((a, b) => b[0] - a[0]);
    const sortedAsks = [...asks].sort((a, b) => a[0] - b[0]);

    const cumBids: { price: number; cumSize: number }[] = [];
    let cumSum = 0;
    for (const [price, size] of sortedBids) {
      cumSum += size;
      cumBids.push({ price, cumSize: cumSum });
    }

    const cumAsks: { price: number; cumSize: number }[] = [];
    cumSum = 0;
    for (const [price, size] of sortedAsks) {
      cumSum += size;
      cumAsks.push({ price, cumSize: cumSum });
    }

    const allPrices = [...cumBids.map(b => b.price), ...cumAsks.map(a => a.price)];
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const priceRange = maxPrice - minPrice || 1;
    const maxDepth = Math.max(cumBids[cumBids.length - 1]?.cumSize || 0, cumAsks[cumAsks.length - 1]?.cumSize || 0) || 1;

    const padding = { top: 20, bottom: 30, left: 10, right: 10 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;
    const priceToX = (price: number) => padding.left + ((price - minPrice) / priceRange) * chartW;
    const depthToY = (depth: number) => padding.top + chartH - (depth / maxDepth) * chartH;

    if (cumBids.length > 1) {
      const grad = ctx.createLinearGradient(0, padding.top + chartH, 0, padding.top);
      grad.addColorStop(0, 'rgba(43,217,106,0.02)');
      grad.addColorStop(0.5, 'rgba(43,217,106,0.15)');
      grad.addColorStop(1, 'rgba(43,217,106,0.35)');
      ctx.beginPath();
      ctx.moveTo(priceToX(cumBids[0].price), depthToY(0));
      for (const pt of cumBids) ctx.lineTo(priceToX(pt.price), depthToY(pt.cumSize));
      ctx.lineTo(priceToX(cumBids[cumBids.length - 1].price), depthToY(0));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < cumBids.length; i++) {
        const x = priceToX(cumBids[i].price), y = depthToY(cumBids[i].cumSize);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(43,217,106,0.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (cumAsks.length > 1) {
      const grad = ctx.createLinearGradient(0, padding.top + chartH, 0, padding.top);
      grad.addColorStop(0, 'rgba(255,77,61,0.02)');
      grad.addColorStop(0.5, 'rgba(255,77,61,0.15)');
      grad.addColorStop(1, 'rgba(255,77,61,0.35)');
      ctx.beginPath();
      ctx.moveTo(priceToX(cumAsks[0].price), depthToY(0));
      for (const pt of cumAsks) ctx.lineTo(priceToX(pt.price), depthToY(pt.cumSize));
      ctx.lineTo(priceToX(cumAsks[cumAsks.length - 1].price), depthToY(0));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < cumAsks.length; i++) {
        const x = priceToX(cumAsks[i].price), y = depthToY(cumAsks[i].cumSize);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255,77,61,0.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.45)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 6; i++) {
      const price = minPrice + (priceRange / 6) * i;
      const x = priceToX(price);
      ctx.fillText(price >= 1000 ? price.toFixed(0) : price.toFixed(2), x, h - 8);
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + chartH);
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    if (cumBids.length > 0 && cumAsks.length > 0) {
      const midPrice = (cumBids[0].price + cumAsks[0].price) / 2;
      const mx = priceToX(midPrice);
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(mx, padding.top);
      ctx.lineTo(mx, padding.top + chartH);
      ctx.strokeStyle = 'rgba(43,217,106,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [isDark]);

  useEffect(() => {
    fetchData().then(draw);
    const iv = setInterval(() => fetchData().then(draw), 5000);
    const observer = new ResizeObserver(() => draw());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { clearInterval(iv); observer.disconnect(); };
  }, [fetchData, draw]);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[200px]">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
