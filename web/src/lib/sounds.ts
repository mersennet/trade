let audioCtx: AudioContext | null = null;

function getCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

export function playSound(type: 'fill' | 'cancel' | 'alert' | 'liquidation') {
  try {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    switch (type) {
      case 'fill':
        osc.frequency.value = 880;
        gain.gain.value = 0.1;
        osc.start();
        osc.stop(ctx.currentTime + 0.08);
        break;
      case 'cancel':
        osc.frequency.value = 440;
        gain.gain.value = 0.08;
        osc.start();
        osc.stop(ctx.currentTime + 0.06);
        break;
      case 'alert':
        osc.frequency.value = 660;
        osc.type = 'triangle';
        gain.gain.value = 0.12;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
        break;
      case 'liquidation':
        osc.frequency.value = 220;
        osc.type = 'sawtooth';
        gain.gain.value = 0.15;
        osc.start();
        osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.5);
        osc.stop(ctx.currentTime + 0.5);
        break;
    }
  } catch {}
}
