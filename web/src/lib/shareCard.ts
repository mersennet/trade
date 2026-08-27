/**
 * Shareable PnL position cards: renders a branded 1200x630 PNG on a canvas
 * and downloads it. Every shared PnL screenshot is a Mersennet ad.
 */

export interface ShareCardData {
  symbol: string;
  isLong: boolean;
  leverage?: number;
  entryPrice: number;
  markPrice: number;
  pnl: number;
  pnlPct: number;
}

const fmt = (n: number, d = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export async function downloadShareCard(data: ShareCardData): Promise<void> {
  const W = 1200;
  const H = 630;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');

  const win = data.pnl >= 0;
  const accent = win ? '#34d399' : '#ff5240';
  const bg = '#0a0e0b';
  const panel = '#101511';
  const dim = '#7b7b8a';
  const fg = '#ececef';

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Accent bar
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 8, H);

  // Brand
  ctx.fillStyle = dim;
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.fillText('MERSENNET TRADE', 64, 84);

  // Symbol + side chip
  ctx.fillStyle = fg;
  ctx.font = '700 64px system-ui, sans-serif';
  ctx.fillText(data.symbol, 64, 180);
  const sideText = data.isLong ? 'LONG' : 'SHORT';
  ctx.font = '700 26px system-ui, sans-serif';
  const sideW = ctx.measureText(sideText).width + 40;
  ctx.fillStyle = win ? 'rgba(52,211,153,0.12)' : 'rgba(255,82,64,0.12)';
  ctx.fillRect(64, 210, sideW, 48);
  ctx.fillStyle = accent;
  ctx.fillText(sideText + (data.leverage ? ` ${data.leverage}×` : ''), 84, 243);

  // PnL hero
  ctx.fillStyle = accent;
  ctx.font = '700 110px system-ui, sans-serif';
  const pnlTxt = `${win ? '+' : ''}${fmt(data.pnl)}`;
  ctx.fillText(pnlTxt, 64, 400);
  ctx.font = '600 44px system-ui, sans-serif';
  ctx.fillText(`${win ? '+' : ''}${fmt(data.pnlPct)}%`, 64, 470);

  // Entry / mark panel
  ctx.fillStyle = panel;
  ctx.fillRect(64, 510, 520, 70);
  ctx.fillStyle = dim;
  ctx.font = '500 22px system-ui, sans-serif';
  ctx.fillText('Entry', 88, 553);
  ctx.fillText('Mark', 320, 553);
  ctx.fillStyle = fg;
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.fillText(fmt(data.entryPrice, 4), 170, 553);
  ctx.fillText(fmt(data.markPrice, 4), 400, 553);

  // Mersenne mark bottom-right
  ctx.fillStyle = 'rgba(43,217,106,0.5)';
  ctx.font = '600 24px system-ui, sans-serif';
  ctx.fillText('trade.mersennet.com', W - 380, H - 48);

  // Download
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Render failed');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mersennet-${data.symbol.replace('/', '-')}-${win ? 'profit' : 'loss'}-${Date.now()}.png`;
  a.click();
  URL.revokeObjectURL(url);
}
