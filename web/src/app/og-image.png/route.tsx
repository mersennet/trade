import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const contentType = 'image/png';
export const size = { width: 1200, height: 630 };

const root: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: 'linear-gradient(135deg, #000000 0%, #04130a 60%, #0a2415 100%)',
  padding: 64,
  color: '#ffffff',
  fontFamily: 'sans-serif',
};

const row: React.CSSProperties = { display: 'flex', alignItems: 'center' };

export async function GET() {
  return new ImageResponse(
    (
      <div style={root}>
        <div style={{ ...row, gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'linear-gradient(135deg, #2bd96a, #7dff9b)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 32,
              fontWeight: 800,
              color: '#04130a',
            }}
          >
            M
          </div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>
            Mersennet Trade
          </div>
          <div
            style={{
              display: 'flex',
              marginLeft: 8,
              padding: '4px 10px',
              borderRadius: 6,
              background: 'rgba(245, 158, 11, 0.2)',
              border: '1px solid rgba(245, 158, 11, 0.5)',
              color: '#fcd34d',
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 1,
            }}
          >
            BETA
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: -2,
              backgroundImage: 'linear-gradient(120deg, #ffffff 0%, #7dff9b 100%)',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            On-chain perpetuals on Mersennet.
          </div>

          <div style={{ display: 'flex', fontSize: 26, color: '#7dff9b', fontWeight: 500 }}>
            MRSN · BTC · ETH · SOL · ARB — Up to 100× leverage — Free testnet MRSN
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 48,
            paddingTop: 24,
            borderTop: '1px solid rgba(255,255,255,0.1)',
            fontSize: 20,
            color: '#94a3b8',
          }}
        >
          <div style={{ display: 'flex' }}>trade.mersennet.com</div>
          <div style={{ display: 'flex' }}>Built by Mersennet</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
