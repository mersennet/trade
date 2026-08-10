'use client';
import { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react';
import { useStore } from '@/stores/useStore';
import { api, createWsConnection } from '@/lib/api';
import { cn, formatPrice, formatNumber } from '@/lib/utils';
import { useDismissable } from '@/hooks/useDismissable';

const DepthChart = lazy(() => import('./DepthChart'));
const DepthHeatmap = lazy(() => import('./DepthHeatmap'));

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
type ChartType = 'candles' | 'line' | 'area';
type ChartMode = 'price' | 'depth' | 'heatmap';
type DrawingTool = 'none' | 'hline' | 'trendline' | 'fib';

interface OhlcvInfo {
  open: number; high: number; low: number; close: number; volume: number; time: number;
}

interface PriceLine { price: number; color: string; label: string; id: string; ref?: any; }
interface TrendLine { p1: { time: number; price: number }; p2: { time: number; price: number }; id: string; }
interface FibLevel { high: number; low: number; id: string; levels: { ratio: number; ref?: any }[]; }

// ---------- Indicator math ----------

function calcSMA(data: number[], period: number): (number | null)[] {
  const r: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += data[j];
    r.push(s / period);
  }
  return r;
}

function calcEMA(data: number[], period: number): (number | null)[] {
  const r: (number | null)[] = []; const k = 2 / (period + 1);
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    if (i === period - 1) { let s = 0; for (let j = 0; j < period; j++) s += data[j]; r.push(s / period); continue; }
    const prev = r[i - 1]; if (prev === null) { r.push(null); continue; }
    r.push(data[i] * k + prev * (1 - k));
  }
  return r;
}

function calcRSI(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = [null];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    if (i < period) { r.push(null); avgGain += gain; avgLoss += loss; continue; }
    if (i === period) { avgGain = (avgGain + gain) / period; avgLoss = (avgLoss + loss) / period; }
    else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; }
    r.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return r;
}

function calcBollinger(closes: number[], period: number, sd: number) {
  const mid = calcSMA(closes, period);
  const upper: (number | null)[] = [], lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    let v = 0; for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]!) ** 2;
    const s = Math.sqrt(v / period);
    upper.push(mid[i]! + sd * s); lower.push(mid[i]! - sd * s);
  }
  return { upper, middle: mid, lower };
}

function calcMACD(closes: number[]) {
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const macd: (number | null)[] = e12.map((v, i) => (v !== null && e26[i] !== null ? v - e26[i]! : null));
  const mv = macd.filter((v): v is number => v !== null);
  const rawSig = calcEMA(mv, 9);
  let si = 0;
  const signal: (number | null)[] = macd.map((v) => (v === null ? null : rawSig[si++] ?? null));
  const hist: (number | null)[] = macd.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i]! : null));
  return { macd, signal, histogram: hist };
}

function calcVWAP(candles: { time: number; high: number; low: number; close: number; volume: number }[]): (number | null)[] {
  const r: (number | null)[] = [];
  let cumTPV = 0, cumVol = 0;
  let prevDay = -1;
  for (const c of candles) {
    const day = Math.floor(c.time / 86400);
    if (day !== prevDay) { cumTPV = 0; cumVol = 0; prevDay = day; }
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume; cumVol += c.volume;
    r.push(cumVol > 0 ? cumTPV / cumVol : null);
  }
  return r;
}

function calcStochastic(candles: { high: number; low: number; close: number }[], kPeriod: number, dPeriod: number) {
  const kVals: (number | null)[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) { kVals.push(null); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hh = Math.max(hh, candles[j].high); ll = Math.min(ll, candles[j].low); }
    kVals.push(hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100);
  }
  const dVals = calcSMA(kVals.map(v => v ?? 0), dPeriod).map((v, i) => kVals[i] === null ? null : v);
  return { k: kVals, d: dVals };
}

function calcATR(candles: { high: number; low: number; close: number }[], period: number): (number | null)[] {
  const r: (number | null)[] = [null];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    trs.push(tr);
    if (i < period) { r.push(null); continue; }
    if (i === period) { r.push(trs.reduce((s, v) => s + v, 0) / period); continue; }
    const prev = r[i - 1]; r.push(prev === null ? null : (prev * (period - 1) + tr) / period);
  }
  return r;
}

function calcIchimoku(candles: { high: number; low: number; close: number }[]) {
  const tenkan: (number | null)[] = [], kijun: (number | null)[] = [], senkouA: (number | null)[] = [], senkouB: (number | null)[] = [];
  const hilo = (arr: typeof candles, start: number, len: number) => {
    let hh = -Infinity, ll = Infinity;
    for (let j = start; j < start + len && j < arr.length; j++) { hh = Math.max(hh, arr[j].high); ll = Math.min(ll, arr[j].low); }
    return (hh + ll) / 2;
  };
  for (let i = 0; i < candles.length; i++) {
    tenkan.push(i >= 8 ? hilo(candles, i - 8, 9) : null);
    kijun.push(i >= 25 ? hilo(candles, i - 25, 26) : null);
    const sa = tenkan[i] !== null && kijun[i] !== null ? (tenkan[i]! + kijun[i]!) / 2 : null;
    senkouA.push(sa);
    senkouB.push(i >= 51 ? hilo(candles, i - 51, 52) : null);
  }
  return { tenkan, kijun, senkouA, senkouB };
}

// ---------- Timeframe helpers ----------

const TF_MS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};

// ---------- Price-axis precision ----------
//
// lightweight-charts defaults to precision=2 / minMove=0.01, which is fine for
// BTC/ETH but truncates MRSN ($0.029560) to "0.03" and MRSN ($0.019356) to
// "0.02" on the price axis — useless for traders. Pick a sane precision based
// on the magnitude of the live price so each market shows enough significant
// digits to distinguish individual ticks.
function pricePrecision(p: number): { precision: number; minMove: number } {
  const v = Math.abs(Number(p));
  if (!isFinite(v) || v === 0)         return { precision: 2, minMove: 0.01 };
  if (v >= 1000)                       return { precision: 2, minMove: 0.01 };
  if (v >= 100)                        return { precision: 2, minMove: 0.01 };
  if (v >= 10)                         return { precision: 3, minMove: 0.001 };
  if (v >= 1)                          return { precision: 4, minMove: 0.0001 };
  if (v >= 0.1)                        return { precision: 5, minMove: 0.00001 };
  if (v >= 0.01)                       return { precision: 6, minMove: 0.000001 };
  if (v >= 0.001)                      return { precision: 7, minMove: 0.0000001 };
  return                                      { precision: 8, minMove: 0.00000001 };
}

function tradeToCandle(existing: any | null, trade: { price: number; size: number; time: number }, tfSec: number) {
  const bucketTime = Math.floor(trade.time / tfSec) * tfSec;
  if (existing && existing.time === bucketTime) {
    return {
      ...existing,
      high: Math.max(existing.high, trade.price),
      low: Math.min(existing.low, trade.price),
      close: trade.price,
      volume: existing.volume + Math.abs(trade.size),
    };
  }
  return { time: bucketTime, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: Math.abs(trade.size) };
}

// ---------- Chart Component ----------

export default function Chart() {
  const { market, theme, tickers } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRefs = useRef<Record<string, any>>({});
  const [tf, setTf] = useState<string>('1h');
  const [chartType, setChartType] = useState<ChartType>('candles');
  const [chartMode, setChartMode] = useState<ChartMode>('price');
  const [showMA, setShowMA] = useState(true);
  const [showRSI, setShowRSI] = useState(false);
  const [showMACD, setShowMACD] = useState(false);
  const [showBB, setShowBB] = useState(false);
  const [showVWAP, setShowVWAP] = useState(false);
  const [showStoch, setShowStoch] = useState(false);
  const [showATR, setShowATR] = useState(false);
  const [showIchi, setShowIchi] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [crosshairData, setCrosshairData] = useState<OhlcvInfo | null>(null);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>('none');
  const [priceLines, setPriceLines] = useState<PriceLine[]>([]);
  const [fibLevels, setFibLevels] = useState<FibLevel[]>([]);
  const [showDrawingPanel, setShowDrawingPanel] = useState(false);
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const drawingPanelRef = useDismissable<HTMLDivElement>(showDrawingPanel, () => setShowDrawingPanel(false));
  const indicatorPanelRef = useDismissable<HTMLDivElement>(showIndicatorPanel, () => setShowIndicatorPanel(false));
  const [loading, setLoading] = useState(true);
  const candlesCache = useRef<any[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const drawClickCount = useRef(0);
  const drawTempPoint = useRef<{ time: number; price: number } | null>(null);

  const isDark = theme === 'dark';

  // Persistent horizontal lines via localStorage
  const storageKey = `mersennet-trade_drawings-${market.id}`;
  useEffect(() => {
    try {
      // Migrate any drawings saved under the predecessor 'pt-drawings-' key.
      const legacyKey = `pt-drawings-${market.id}`;
      const legacy = localStorage.getItem(legacyKey);
      if (legacy && !localStorage.getItem(storageKey)) {
        localStorage.setItem(storageKey, legacy);
        localStorage.removeItem(legacyKey);
      }
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (saved.priceLines) setPriceLines(saved.priceLines);
      if (saved.fibLevels) setFibLevels(saved.fibLevels);
    } catch {}
  }, [market.id]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ priceLines, fibLevels }));
    } catch {}
  }, [priceLines, fibLevels, storageKey]);

  const buildChart = useCallback(async () => {
    if (!containerRef.current) return;

    if (chartRef.current) {
      try { chartRef.current.remove(); } catch {}
      chartRef.current = null;
      seriesRefs.current = {};
    }

    const lc = await import('lightweight-charts');
    if (!containerRef.current) return;

    const hasSubPane = showRSI || showMACD || showStoch || showATR;

    const chart = lc.createChart(containerRef.current, {
      layout: {
        background: { type: lc.ColorType.Solid, color: isDark ? '#050507' : '#ffffff' },
        textColor: isDark ? '#6e6b7b' : '#71717a',
        fontFamily: 'Sora, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)' },
        horzLines: { color: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)' },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: isDark ? 'rgba(125,255,155,0.3)' : 'rgba(15,174,98,0.3)', style: 2 },
        horzLine: { color: isDark ? 'rgba(125,255,155,0.3)' : 'rgba(15,174,98,0.3)', style: 2 },
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
        scaleMargins: { top: 0.05, bottom: hasSubPane ? 0.3 : 0.15 },
      },
      timeScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
        timeVisible: true,
      },
      handleScroll: { vertTouchDrag: false },
    } as any);

    chartRef.current = chart;

    // Seed the price-axis precision from whatever price hint is currently in
    // the store. Refined later by the precisionUpdate effect once a fresh
    // ticker tick lands.
    const seedT = tickers[market.id] as { markPrice?: number; oracleMarkUsd?: number } | undefined;
    const seedPrice = seedT?.oracleMarkUsd || seedT?.markPrice || 0;
    const initialFmt = pricePrecision(seedPrice);
    const priceFormatOpt = { type: 'price' as const, precision: initialFmt.precision, minMove: initialFmt.minMove };

    let mainSeries: any;
    if (chartType === 'candles') {
      mainSeries = chart.addSeries(lc.CandlestickSeries, {
        upColor: '#34d399', downColor: '#f87171',
        borderUpColor: '#34d399', borderDownColor: '#f87171',
        wickUpColor: '#34d39980', wickDownColor: '#f8717180',
        priceFormat: priceFormatOpt,
      });
    } else if (chartType === 'line') {
      mainSeries = chart.addSeries(lc.LineSeries, {
        color: '#7dff9b', lineWidth: 2,
        priceFormat: priceFormatOpt,
      });
    } else {
      mainSeries = chart.addSeries(lc.AreaSeries, {
        topColor: 'rgba(125,255,155,0.4)', bottomColor: 'rgba(125,255,155,0.02)',
        lineColor: '#7dff9b', lineWidth: 2,
        priceFormat: priceFormatOpt,
      });
    }
    seriesRefs.current.main = mainSeries;

    const volumeSeries = chart.addSeries(lc.HistogramSeries, {
      color: 'rgba(125,255,155,0.15)',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    seriesRefs.current.volume = volumeSeries;

    // MA
    if (showMA) {
      seriesRefs.current.sma20 = chart.addSeries(lc.LineSeries, {
        color: '#fbbf24', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      seriesRefs.current.ema50 = chart.addSeries(lc.LineSeries, {
        color: '#22d3ee', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }

    // Bollinger
    if (showBB) {
      seriesRefs.current.bbUpper = chart.addSeries(lc.LineSeries, {
        color: 'rgba(125,255,155,0.4)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      seriesRefs.current.bbLower = chart.addSeries(lc.LineSeries, {
        color: 'rgba(125,255,155,0.4)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }

    // VWAP
    if (showVWAP) {
      seriesRefs.current.vwap = chart.addSeries(lc.LineSeries, {
        color: '#f59e0b', lineWidth: 2, lineStyle: 0, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
      });
    }

    // Ichimoku
    if (showIchi) {
      seriesRefs.current.ichiTenkan = chart.addSeries(lc.LineSeries, {
        color: '#22d3ee', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      seriesRefs.current.ichiKijun = chart.addSeries(lc.LineSeries, {
        color: '#f87171', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      seriesRefs.current.ichiSenkouA = chart.addSeries(lc.LineSeries, {
        color: 'rgba(52,211,153,0.4)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      seriesRefs.current.ichiSenkouB = chart.addSeries(lc.LineSeries, {
        color: 'rgba(248,113,113,0.4)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }

    // RSI pane
    if (showRSI) {
      seriesRefs.current.rsi = chart.addSeries(lc.LineSeries, {
        color: '#7dff9b', lineWidth: 2, priceScaleId: 'rsi', priceLineVisible: false, lastValueVisible: true,
      });
      chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0.75, bottom: 0.02 }, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)' });
      seriesRefs.current.rsiOB = chart.addSeries(lc.LineSeries, {
        color: isDark ? 'rgba(248,113,113,0.3)' : 'rgba(220,38,38,0.3)', lineWidth: 1, lineStyle: 2, priceScaleId: 'rsi',
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      seriesRefs.current.rsiOS = chart.addSeries(lc.LineSeries, {
        color: isDark ? 'rgba(52,211,153,0.3)' : 'rgba(22,163,74,0.3)', lineWidth: 1, lineStyle: 2, priceScaleId: 'rsi',
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }

    // Stochastic pane
    if (showStoch) {
      const stochTop = showRSI ? 0.55 : 0.75;
      seriesRefs.current.stochK = chart.addSeries(lc.LineSeries, {
        color: '#22d3ee', lineWidth: 1, priceScaleId: 'stoch', priceLineVisible: false, lastValueVisible: true,
      });
      seriesRefs.current.stochD = chart.addSeries(lc.LineSeries, {
        color: '#f97316', lineWidth: 1, priceScaleId: 'stoch', priceLineVisible: false, lastValueVisible: false,
      });
      chart.priceScale('stoch').applyOptions({ scaleMargins: { top: stochTop, bottom: 0.02 } });
    }

    // ATR pane
    if (showATR) {
      const atrTop = showRSI && showStoch ? 0.4 : showRSI || showStoch ? 0.55 : 0.75;
      seriesRefs.current.atr = chart.addSeries(lc.LineSeries, {
        color: '#fb923c', lineWidth: 1, priceScaleId: 'atr', priceLineVisible: false, lastValueVisible: true,
      });
      chart.priceScale('atr').applyOptions({ scaleMargins: { top: atrTop, bottom: 0.02 } });
    }

    // MACD pane
    if (showMACD) {
      const macdTop = hasSubPane && !showMACD ? 0.6 : 0.75;
      seriesRefs.current.macdLine = chart.addSeries(lc.LineSeries, {
        color: '#22d3ee', lineWidth: 1, priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false,
      });
      seriesRefs.current.macdSignal = chart.addSeries(lc.LineSeries, {
        color: '#f97316', lineWidth: 1, priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false,
      });
      seriesRefs.current.macdHist = chart.addSeries(lc.HistogramSeries, {
        priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false,
      });
      chart.priceScale('macd').applyOptions({
        scaleMargins: { top: showRSI ? 0.6 : 0.75, bottom: 0.02 },
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
      });
    }

    // Crosshair
    chart.subscribeCrosshairMove((param: any) => {
      if (!param || !param.time) { setCrosshairData(null); return; }
      const md = param.seriesData?.get(mainSeries);
      const vd = param.seriesData?.get(volumeSeries);
      if (md) {
        setCrosshairData({
          open: md.open ?? md.value ?? 0, high: md.high ?? md.value ?? 0,
          low: md.low ?? md.value ?? 0, close: md.close ?? md.value ?? 0,
          volume: vd?.value ?? 0, time: param.time as number,
        });
      }
    });

    // Chart click handler for drawing tools
    chart.subscribeClick((param: any) => {
      if (drawingTool === 'none' || !param.time || !param.point) return;
      const price = mainSeries.coordinateToPrice(param.point.y);
      if (price === null || price === undefined) return;

      if (drawingTool === 'hline') {
        const id = `hl-${Date.now()}`;
        const ref = mainSeries.createPriceLine({
          price, color: '#7dff9b', lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: `${formatPrice(price)}`,
        });
        setPriceLines(prev => [...prev, { price, color: '#7dff9b', label: `${formatPrice(price)}`, id, ref }]);
        setDrawingTool('none');
      } else if (drawingTool === 'fib') {
        if (drawClickCount.current === 0) {
          drawTempPoint.current = { time: param.time as number, price };
          drawClickCount.current = 1;
        } else {
          const p1 = drawTempPoint.current!;
          const high = Math.max(p1.price, price);
          const low = Math.min(p1.price, price);
          const id = `fib-${Date.now()}`;
          const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const colors = ['#34d399', '#22d3ee', '#3b82f6', '#b07cff', '#f59e0b', '#f87171', '#ef4444'];
          const levels = ratios.map((ratio, idx) => {
            const lvlPrice = high - ratio * (high - low);
            const ref = mainSeries.createPriceLine({
              price: lvlPrice, color: colors[idx], lineWidth: 1, lineStyle: 2,
              axisLabelVisible: true, title: `${(ratio * 100).toFixed(1)}%`,
            });
            return { ratio, ref };
          });
          setFibLevels(prev => [...prev, { high, low, id, levels }]);
          drawClickCount.current = 0;
          drawTempPoint.current = null;
          setDrawingTool('none');
        }
      }
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    });
    ro.observe(containerRef.current);

    await loadCandles();

    // Re-apply price lines after rebuild
    for (const pl of priceLines) {
      try {
        pl.ref = mainSeries.createPriceLine({
          price: pl.price, color: pl.color, lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: pl.label,
        });
      } catch {}
    }
    for (const fb of fibLevels) {
      const colors = ['#34d399', '#22d3ee', '#3b82f6', '#b07cff', '#f59e0b', '#f87171', '#ef4444'];
      fb.levels.forEach((lvl, idx) => {
        try {
          const lvlPrice = fb.high - lvl.ratio * (fb.high - fb.low);
          lvl.ref = mainSeries.createPriceLine({
            price: lvlPrice, color: colors[idx] || '#7dff9b', lineWidth: 1, lineStyle: 2,
            axisLabelVisible: true, title: `${(lvl.ratio * 100).toFixed(1)}%`,
          });
        } catch {}
      });
    }

    return () => { ro.disconnect(); chart.remove(); };
  }, [theme, chartType, showMA, showRSI, showBB, showMACD, showVWAP, showStoch, showATR, showIchi, isDark, drawingTool]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    buildChart().then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, [buildChart]);

  useEffect(() => {
    // Show the loading overlay immediately on market/timeframe change so the
    // user gets visual feedback before the API round-trip completes.
    setLoading(true);
    if (chartRef.current && seriesRefs.current.main) loadCandles();
    // Re-seed when the live oracle price for this market becomes available so we don't
    // get stuck showing the static default ($80k for BTC, $1 for MRSN, etc.).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.id, tf, (tickers[market.id] as { oracleMarkUsd?: number } | undefined)?.oracleMarkUsd]);

  // Position + bracket overlay lines (entry / liquidation / TP / SL) drawn on
  // the main series — Hyperliquid-style visual position management.
  const positions = useStore((s) => s.positions);
  const brackets = useStore((s) => s.brackets);
  const walletAddress = useStore((s) => s.wallet.address);
  const overlayRefs = useRef<unknown[]>([]);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setInterval> | null = null;

    const apply = () => {
      const series = seriesRefs.current.main;
      if (!series) return false;
      for (const ref of overlayRefs.current) {
        try { (series as { removePriceLine: (r: unknown) => void }).removePriceLine(ref); } catch { /* gone */ }
      }
      overlayRefs.current = [];

      const add = (price: number, color: string, title: string, dashed = false) => {
        if (!price || price <= 0) return;
        try {
          const ref = (series as { createPriceLine: (o: object) => unknown }).createPriceLine({
            price, color, lineWidth: 1, lineStyle: dashed ? 2 : 0,
            axisLabelVisible: true, title,
          });
          overlayRefs.current.push(ref);
        } catch { /* series mid-rebuild */ }
      };

      const pos = positions.find((p) => p.marketId === market.id);
      if (pos) {
        const entry = Number(pos.entryPrice);
        add(entry, '#5b8cff', 'Entry');
        const liq = Number(pos.liquidationPrice || 0);
        if (liq > 0) add(liq, '#ff5240', 'Liq', true);
      }
      const br = brackets.find(
        (b) => b.marketId === market.id && (!walletAddress || b.owner.toLowerCase() === walletAddress.toLowerCase())
      );
      if (br) {
        if (br.tp) add(Number(br.tp), '#34d399', 'TP');
        if (br.sl) add(Number(br.sl), '#ff9a3c', 'SL');
      }
      return true;
    };

    if (!apply()) {
      // Chart may still be building (async lib import) — retry briefly.
      retry = setInterval(() => { if (!cancelled && apply() && retry) clearInterval(retry); }, 300);
    }
    return () => {
      cancelled = true;
      if (retry) clearInterval(retry);
      const series = seriesRefs.current.main;
      for (const ref of overlayRefs.current) {
        try { (series as { removePriceLine: (r: unknown) => void })?.removePriceLine(ref); } catch { /* gone */ }
      }
      overlayRefs.current = [];
    };
  }, [positions, brackets, market.id, walletAddress]);

  // Keep the price-axis precision in sync with the actual market magnitude.
  // We track the last applied precision so we don't churn applyOptions on
  // every WS tick — only when the order of magnitude actually shifts
  // (e.g. switching BTC → MRSN or MRSN mooning past $0.10).
  const lastPrecisionRef = useRef<number>(-1);
  useEffect(() => {
    const t = tickers[market.id] as { markPrice?: number; oracleMarkUsd?: number } | undefined;
    const p = t?.oracleMarkUsd || t?.markPrice || 0;
    if (!p) return;
    const fmt = pricePrecision(p);
    if (lastPrecisionRef.current === fmt.precision) return;
    lastPrecisionRef.current = fmt.precision;
    try {
      seriesRefs.current.main?.applyOptions({
        priceFormat: { type: 'price', precision: fmt.precision, minMove: fmt.minMove },
      });
    } catch { /* series not ready yet — buildChart will pick up the seed */ }
  }, [market.id, tickers]);

  // Real-time candle updates via WebSocket
  useEffect(() => {
    const tfSec = TF_MS[tf] || 3600;
    // Reconnect with capped exponential backoff so candles resume after a
    // dropped connection instead of freezing. The disposed guard prevents
    // ws.close() in cleanup from scheduling a zombie reconnect.
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    function connect() {
      if (disposed) return;
      const ws = createWsConnection();
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        ws.send(JSON.stringify({ action: 'subscribe', channel: `trades:${market.id}` }));
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type !== 'trade' || data.marketId !== market.id) return;

          const tradeTime = typeof data.time === 'string' ? Math.floor(new Date(data.time).getTime() / 1000) : Math.floor(data.time);
          const trade = { price: Number(data.price), size: Number(data.size), time: tradeTime };
          if (!trade.price || isNaN(trade.price)) return;

          const cache = candlesCache.current;
          const lastCandle = cache.length > 0 ? cache[cache.length - 1] : null;
          const updated = tradeToCandle(lastCandle, trade, tfSec);

          if (lastCandle && updated.time === lastCandle.time) {
            cache[cache.length - 1] = updated;
          } else {
            cache.push(updated);
          }

          const refs = seriesRefs.current;
          if (!refs.main) return;

          if (chartType === 'candles') {
            refs.main.update(updated);
          } else {
            refs.main.update({ time: updated.time, value: updated.close });
          }
          refs.volume?.update({
            time: updated.time, value: updated.volume,
            color: updated.close >= updated.open ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)',
          });
        } catch {}
      };

      ws.onclose = () => {
        if (disposed) return;
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
  }, [market.id, tf, chartType]);

  async function loadCandles() {
    const refs = seriesRefs.current;
    if (!refs.main) return;
    try {
      const now = Date.now();
      const from = now - 14 * 24 * 3600 * 1000;
      const { candles } = await api.getCandles(market.id, tf, from, now);
      if (candles.length > 0) {
        candlesCache.current = candles;
        applyData(candles);
        setLoading(false);
        return;
      }
    } catch {
      // fall through to synthetic
    }
    // No real candles — seed synthetic from a freshly fetched oracle price
    // so we never show a stale store value (e.g. $1 when MRSN is actually $0.02).
    let seedPrice = 0;
    try {
      const ticker = await api.getTicker(market.id);
      const t = ticker as { markPrice?: number; oracleMarkUsd?: number } | undefined;
      seedPrice = t?.oracleMarkUsd || t?.markPrice || 0;
    } catch {
      // ignore — generateSyntheticCandles will use store/default
    }
    const s = generateSyntheticCandles(seedPrice);
    candlesCache.current = s;
    applyData(s);
    setLoading(false);
  }

  function applyData(candles: any[]) {
    const refs = seriesRefs.current;
    if (!refs.main) return;

    if (chartType === 'candles') refs.main.setData(candles);
    else refs.main.setData(candles.map((c: any) => ({ time: c.time, value: c.close })));

    refs.volume?.setData(candles.map((c: any) => ({
      time: c.time, value: c.volume ?? 0,
      color: c.close >= c.open ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)',
    })));

    const closes = candles.map((c: any) => c.close);
    const times = candles.map((c: any) => c.time);
    const toSeries = (vals: (number | null)[]) => vals.map((v, i) => v !== null ? { time: times[i], value: v } : null).filter(Boolean);

    if (refs.sma20) refs.sma20.setData(toSeries(calcSMA(closes, 20)));
    if (refs.ema50) refs.ema50.setData(toSeries(calcEMA(closes, 50)));

    if (refs.rsi) {
      const rsiV = calcRSI(closes, 14);
      refs.rsi.setData(toSeries(rsiV));
      const rsiTimes = times.filter((_: any, i: number) => rsiV[i] !== null);
      refs.rsiOB?.setData(rsiTimes.map((t: any) => ({ time: t, value: 70 })));
      refs.rsiOS?.setData(rsiTimes.map((t: any) => ({ time: t, value: 30 })));
    }

    if (refs.bbUpper && refs.bbLower) {
      const bb = calcBollinger(closes, 20, 2);
      refs.bbUpper.setData(toSeries(bb.upper));
      refs.bbLower.setData(toSeries(bb.lower));
    }

    if (refs.macdLine && refs.macdSignal && refs.macdHist) {
      const m = calcMACD(closes);
      refs.macdLine.setData(toSeries(m.macd));
      refs.macdSignal.setData(toSeries(m.signal));
      refs.macdHist.setData(m.histogram.map((v, i) => v !== null ? { time: times[i], value: v, color: v >= 0 ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)' } : null).filter(Boolean));
    }

    if (refs.vwap) refs.vwap.setData(toSeries(calcVWAP(candles)));

    if (refs.stochK && refs.stochD) {
      const st = calcStochastic(candles, 14, 3);
      refs.stochK.setData(toSeries(st.k));
      refs.stochD.setData(toSeries(st.d));
    }

    if (refs.atr) refs.atr.setData(toSeries(calcATR(candles, 14)));

    if (refs.ichiTenkan) {
      const ich = calcIchimoku(candles);
      refs.ichiTenkan.setData(toSeries(ich.tenkan));
      refs.ichiKijun?.setData(toSeries(ich.kijun));
      refs.ichiSenkouA?.setData(toSeries(ich.senkouA));
      refs.ichiSenkouB?.setData(toSeries(ich.senkouB));
    }
  }

  function generateSyntheticCandles(seedOverride = 0) {
    const now = Math.floor(Date.now() / 1000);
    const candles = [];
    const ticker = tickers[market.id];
    // Priority: explicit seed (from fresh API call) → store ticker oracle → store ticker mark → default.
    type ExtendedTicker = { markPrice?: number; oracleMarkUsd?: number };
    const t = ticker as ExtendedTicker | undefined;
    const oraclePrice = t?.oracleMarkUsd ?? 0;
    const tickerPrice = t?.markPrice ?? 0;
    const seed = seedOverride > 0 ? seedOverride : (oraclePrice > 0 ? oraclePrice : tickerPrice);
    const defaultPrices: Record<string, number> = {
      BTC: 80000, ETH: 2400, SOL: 90, MRSN: 0.02, ARB: 1.2, AVAX: 35, LINK: 18,
      DOGE: 0.15, WIF: 2.5, ONDO: 1.5, SUI: 3.5, OP: 2.8, MATIC: 0.7, TIA: 12, JUP: 1.1,
    };
    let price = seed > 0 ? seed : (defaultPrices[market.base] || 100);
    // Walk backwards in time so the most recent candle ends near the seed.
    // Use very low volatility so the synthetic series doesn't look like fake noise.
    const vol = 0.005; // 0.5% per hour
    for (let i = 200; i >= 0; i--) {
      const time = now - i * 3600;
      const open = price;
      const change = (Math.random() - 0.5) * price * vol;
      price = Math.max(price * 0.7, price + change);
      const high = Math.max(open, price) * (1 + Math.random() * 0.002);
      const low = Math.min(open, price) * (1 - Math.random() * 0.002);
      const volume = 0; // No fake volume during beta — make it obvious there are no trades yet.
      candles.push({ time, open, high, low, close: price, volume });
    }
    return candles;
  }

  function clearAllDrawings() {
    const refs = seriesRefs.current;
    for (const pl of priceLines) { try { refs.main?.removePriceLine(pl.ref); } catch {} }
    for (const fb of fibLevels) { fb.levels.forEach(l => { try { refs.main?.removePriceLine(l.ref); } catch {} }); }
    setPriceLines([]);
    setFibLevels([]);
  }

  function removeLastDrawing() {
    const refs = seriesRefs.current;
    if (fibLevels.length > 0) {
      const last = fibLevels[fibLevels.length - 1];
      last.levels.forEach(l => { try { refs.main?.removePriceLine(l.ref); } catch {} });
      setFibLevels(prev => prev.slice(0, -1));
    } else if (priceLines.length > 0) {
      const last = priceLines[priceLines.length - 1];
      try { refs.main?.removePriceLine(last.ref); } catch {}
      setPriceLines(prev => prev.slice(0, -1));
    }
  }

  const chartTypeIcons: Record<ChartType, React.ReactNode> = {
    candles: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 5v4M9 13v6M15 3v6M15 15v6" /><rect x="7" y="9" width="4" height="4" rx="0.5" /><rect x="13" y="9" width="4" height="6" rx="0.5" />
      </svg>
    ),
    line: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
    area: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 6-6" />
      </svg>
    ),
  };

  const INDICATORS = [
    { key: 'ma', label: 'MA', state: showMA, setter: setShowMA },
    { key: 'bb', label: 'BB', state: showBB, setter: setShowBB },
    { key: 'vwap', label: 'VWAP', state: showVWAP, setter: setShowVWAP },
    { key: 'ichi', label: 'Ichi', state: showIchi, setter: setShowIchi },
    { key: 'rsi', label: 'RSI', state: showRSI, setter: setShowRSI },
    { key: 'stoch', label: 'Stoch', state: showStoch, setter: setShowStoch },
    { key: 'atr', label: 'ATR', state: showATR, setter: setShowATR },
    { key: 'macd', label: 'MACD', state: showMACD, setter: setShowMACD },
  ] as const;

  return (
    <div
      className={cn(
        'bg-surface overflow-hidden flex flex-col transition-all duration-300',
        'border border-border rounded-xl md:border-0 md:rounded-none',
        isFullscreen ? 'fixed inset-0 z-[9999] !rounded-none !border-none' : 'h-full'
      )}
    >
      {/* Toolbar */}
      {/* flex-wrap: at narrow desktop widths the right-hand tool group wraps
          to a second row instead of overflowing behind the order book panel
          (the old overflow-x scroll had no scrollbar, so wrapped-out tools
          like Indicators were unreachable). */}
      <div className="flex items-center justify-between gap-1 px-2 md:px-3 py-1.5 md:py-2 border-b border-border flex-wrap">
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          <button onClick={() => setChartMode('price')} className={cn('px-2 py-1 text-[11px] font-medium rounded transition-all', chartMode === 'price' ? 'bg-surface-2 text-foreground' : 'text-dim hover:text-muted')}>Price</button>
          <button onClick={() => setChartMode('depth')} className={cn('px-2 py-1 text-[11px] font-medium rounded transition-all', chartMode === 'depth' ? 'bg-surface-2 text-foreground' : 'text-dim hover:text-muted')}>Depth</button>
          <button onClick={() => setChartMode('heatmap')} className={cn('px-2 py-1 text-[11px] font-medium rounded transition-all', chartMode === 'heatmap' ? 'bg-surface-2 text-foreground' : 'text-dim hover:text-muted')}>Heatmap</button>

          {chartMode === 'price' && (
            <>
              <div className="w-px h-4 bg-border mx-1" />
              {TIMEFRAMES.map((t) => (
                <button key={t} onClick={() => setTf(t)}
                  className={cn('px-1.5 md:px-2 py-0.5 text-[11px] rounded transition-all duration-200', tf === t ? 'bg-primary/15 text-primary font-medium' : 'text-dim hover:text-muted hover:bg-surface-2')}>
                  {t}
                </button>
              ))}
              <div className="w-px h-4 bg-border mx-1" />
              {(['candles', 'line', 'area'] as ChartType[]).map((ct) => (
                <button key={ct} onClick={() => setChartType(ct)} title={ct.charAt(0).toUpperCase() + ct.slice(1)}
                  className={cn('px-1.5 py-0.5 text-[11px] rounded transition-all duration-200', chartType === ct ? 'bg-primary/15 text-primary' : 'text-dim hover:text-muted hover:bg-surface-2')}>
                  {chartTypeIcons[ct]}
                </button>
              ))}
            </>
          )}
        </div>

        {chartMode === 'price' && (
          <div className="flex items-center gap-1 md:gap-1.5 shrink-0">
            {/* Indicators dropdown (keeps the toolbar compact; active count shown on the trigger) */}
            <div className="relative" ref={indicatorPanelRef}>
              <button onClick={() => { setShowIndicatorPanel(!showIndicatorPanel); setShowDrawingPanel(false); }}
                className={cn('flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded transition-all',
                  showIndicatorPanel || INDICATORS.some(i => i.state) ? 'bg-primary/15 text-primary' : 'text-dim hover:text-muted hover:bg-surface-2')}>
                Indicators
                {INDICATORS.filter(i => i.state).length > 0 && (
                  <span className="text-[9px] font-bold bg-primary/20 rounded px-1 leading-4">{INDICATORS.filter(i => i.state).length}</span>
                )}
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {showIndicatorPanel && (
                <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl z-50 py-1 min-w-[170px]">
                  {INDICATORS.map(({ key, label, state, setter }) => (
                    <button key={key} onClick={() => setter(!state)}
                      className={cn('flex items-center justify-between w-full text-left px-3 py-1.5 text-[11px] transition-colors',
                        state ? 'text-primary' : 'text-foreground hover:bg-surface-2')}>
                      {label}
                      {state && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="w-px h-4 bg-border mx-0.5" />

            {/* Drawing tools */}
            <div className="relative" ref={drawingPanelRef}>
              <button onClick={() => { setShowDrawingPanel(!showDrawingPanel); setShowIndicatorPanel(false); }}
                className={cn('p-1 rounded transition-all', showDrawingPanel || drawingTool !== 'none' ? 'bg-primary/15 text-primary' : 'text-dim hover:text-muted hover:bg-surface-2')}
                title="Drawing Tools">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
              {showDrawingPanel && (
                <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl z-50 py-1 min-w-[140px]">
                  <button onClick={() => { setDrawingTool('hline'); setShowDrawingPanel(false); }}
                    className={cn('flex items-center gap-2 w-full text-left px-3 py-1.5 text-[11px] transition-colors', drawingTool === 'hline' ? 'text-primary bg-primary/10' : 'text-foreground hover:bg-surface-2')}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="12" x2="22" y2="12" /></svg>
                    Horizontal Line
                  </button>
                  <button onClick={() => { setDrawingTool('fib'); drawClickCount.current = 0; drawTempPoint.current = null; setShowDrawingPanel(false); }}
                    className={cn('flex items-center gap-2 w-full text-left px-3 py-1.5 text-[11px] transition-colors', drawingTool === 'fib' ? 'text-primary bg-primary/10' : 'text-foreground hover:bg-surface-2')}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 4h20M2 9h20M2 14h20M2 19h20" /></svg>
                    Fib Retracement
                  </button>
                  <div className="h-px bg-border my-1" />
                  <button onClick={() => { removeLastDrawing(); setShowDrawingPanel(false); }}
                    className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[11px] text-yellow hover:bg-surface-2 transition-colors">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /></svg>
                    Undo Last
                  </button>
                  <button onClick={() => { clearAllDrawings(); setShowDrawingPanel(false); }}
                    className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[11px] text-red hover:bg-surface-2 transition-colors">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                    Clear All
                  </button>
                </div>
              )}
            </div>

            <button onClick={() => setIsFullscreen(p => !p)}
              className="text-dim hover:text-muted transition-colors p-1 rounded hover:bg-surface-2"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFullscreen ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Drawing mode banner */}
      {drawingTool !== 'none' && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-primary/10 border-b border-primary/20 text-[11px]">
          <span className="text-primary font-medium">
            {drawingTool === 'hline' && 'Click chart to place horizontal line'}
            {drawingTool === 'fib' && (drawClickCount.current === 0 ? 'Click chart for high point' : 'Click chart for low point')}
          </span>
          <button onClick={() => { setDrawingTool('none'); drawClickCount.current = 0; drawTempPoint.current = null; }}
            className="text-primary/70 hover:text-primary font-medium">Cancel (Esc)</button>
        </div>
      )}

      {chartMode === 'depth' ? (
        <div className="flex-1 min-h-[300px]">
          <Suspense fallback={<div className="flex items-center justify-center h-full text-dim text-xs">Loading depth chart...</div>}>
            <DepthChart />
          </Suspense>
        </div>
      ) : chartMode === 'heatmap' ? (
        <div className="flex-1 min-h-[300px]">
          <Suspense fallback={<div className="flex items-center justify-center h-full text-dim text-xs">Loading heatmap...</div>}>
            <DepthHeatmap />
          </Suspense>
        </div>
      ) : (
        <>
          {crosshairData && (
            <div className="flex items-center gap-2 md:gap-3 px-3 py-1 text-[10px] font-mono border-b border-border bg-surface/80 backdrop-blur-sm overflow-x-auto scrollbar-none">
              <span className="text-muted">O</span><span className="text-foreground">{formatPrice(crosshairData.open)}</span>
              <span className="text-muted">H</span><span className="text-green">{formatPrice(crosshairData.high)}</span>
              <span className="text-muted">L</span><span className="text-red">{formatPrice(crosshairData.low)}</span>
              <span className="text-muted">C</span>
              <span className={crosshairData.close >= crosshairData.open ? 'text-green' : 'text-red'}>{formatPrice(crosshairData.close)}</span>
              <span className="text-muted">V</span><span className="text-foreground">{formatNumber(crosshairData.volume)}</span>
              {showMA && <><span className="text-[#fbbf24]">SMA20</span><span className="text-[#22d3ee]">EMA50</span></>}
              {showBB && <span className="text-primary/60">BB(20,2)</span>}
              {showVWAP && <span className="text-[#f59e0b]">VWAP</span>}
              {showIchi && <span className="text-[#22d3ee]/60">Ichimoku</span>}
            </div>
          )}
          <div className="relative flex-1 min-h-[300px]">
            <div ref={containerRef} className={cn('absolute inset-0', drawingTool !== 'none' && 'cursor-crosshair')} />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface/60 backdrop-blur-[1px] z-10 pointer-events-none transition-opacity duration-200">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface-2/80 border border-border">
                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" className="text-primary" />
                  </svg>
                  <span className="text-[11px] text-muted font-medium">
                    Loading <span className="text-foreground font-semibold">{market.base}</span>
                  </span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
