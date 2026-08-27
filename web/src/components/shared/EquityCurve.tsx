'use client';
import { useCallback, useEffect, useRef } from 'react';

/** Compact equity/PnL line chart (lightweight-charts), green when the final
 * value is up, red when down. Shared by Analytics and Portfolio. */
export default function EquityCurve({ data, height = 180 }: { data: { time: number; value: number }[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<unknown>(null);

  const initChart = useCallback(async () => {
    if (!containerRef.current || data.length < 2) return;
    const { createChart, LineSeries } = await import('lightweight-charts');

    if (chartRef.current) {
      (chartRef.current as { remove: () => void }).remove();
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgba(255,255,255,0.4)',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(43,217,106,0.25)', labelBackgroundColor: '#101511' },
        horzLine: { color: 'rgba(43,217,106,0.25)', labelBackgroundColor: '#101511' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)' },
    });

    const series = chart.addSeries(LineSeries, {
      color: data[data.length - 1].value >= 0 ? '#34d399' : '#ef4444',
      lineWidth: 2,
      crosshairMarkerRadius: 4,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const deduped = data.reduce<{ time: number; value: number }[]>((acc, d) => {
      if (acc.length === 0 || acc[acc.length - 1].time !== d.time) acc.push(d);
      else acc[acc.length - 1] = d;
      return acc;
    }, []);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    series.setData(deduped as any);
    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [data, height]);

  useEffect(() => {
    initChart();
    return () => {
      if (chartRef.current) (chartRef.current as { remove: () => void }).remove();
    };
  }, [initChart]);

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center text-dim text-xs" style={{ height }}>
        Not enough trades for a curve yet
      </div>
    );
  }

  return <div ref={containerRef} className="w-full" />;
}
