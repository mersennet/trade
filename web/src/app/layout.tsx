import type { Metadata } from 'next';
import './globals.css';
import Providers from '@/components/Providers';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import BottomBar from '@/components/layout/BottomBar';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import StatusLine from '@/components/layout/StatusLine';
import WrongNetworkModal from '@/components/shared/WrongNetworkModal';
import WelcomeModal from '@/components/beta/WelcomeModal';
import Footer from '@/components/beta/Footer';

const SITE_URL = 'https://trade.mersennet.com';
const OG_IMAGE = `${SITE_URL}/og-image.png`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Mersennet Trade: Perpetuals on the Native On-Chain Order Book',
    template: '%s · Mersennet Trade',
  },
  description: 'Trade perpetuals — MRSN, BTC, ETH, SOL and more — on Mersennet, the zero-knowledge L1 with a native on-chain order book and permissionless market listing. Atomic matching, testnet MRSN from the faucet.',
  applicationName: 'Mersennet Trade',
  keywords: ['Mersennet', 'MRSN', 'perpetuals', 'perps', 'DEX', 'DeFi', 'on-chain', 'derivatives', 'zero-knowledge', 'CLOB'],
  authors: [{ name: 'Mersennet' }],
  // No global `alternates.canonical`: the root layout's value is inherited by
  // every route, which would declare the redirecting homepage as canonical for
  // /trade, /markets, etc. and risk deindexing them.
  openGraph: {
    title: 'Mersennet Trade: Perpetuals on the Native On-Chain Order Book',
    description: 'Trade perps on Mersennet\u2019s native on-chain order book. Atomic matching, permissionless listings, free testnet MRSN.',
    url: SITE_URL,
    siteName: 'Mersennet Trade',
    type: 'website',
    locale: 'en_US',
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: 'Mersennet Trade: Perpetuals on Mersennet' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Mersennet Trade: Perpetuals on Mersennet',
    description: 'On-chain perpetual futures on the Mersennet zero-knowledge L1.',
    images: [OG_IMAGE],
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  other: {
    'apple-mobile-web-app-title': 'Mersennet Trade',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before first paint to avoid a black flash
            for light-mode users (zustand persists under "mersennet-trade-store"). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t='dark';var s=localStorage.getItem('mersennet-trade-store');if(s){var p=JSON.parse(s);if(p&&p.state&&p.state.theme){t=p.state.theme;}}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#030604" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500;700;800&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased overscroll-none">
        <Providers>
          <div className="flex min-h-[100dvh]">
            <Sidebar />
            <div className="flex-1 min-w-0 flex flex-col md:ml-[52px] xl:ml-[180px]">
              {/* One header, one optional dismissible strip. The old beta
                  banner is now a compact TESTNET pill inside the header. */}
              <Header />
              <AnnouncementBar />
              <main className="page-glow flex-1 flex flex-col pb-[52px] md:pb-6">
                <ErrorBoundary>{children}</ErrorBoundary>
                <Footer />
              </main>
            </div>
          </div>
          <BottomBar />
          <StatusLine />
          <WelcomeModal />
          <WrongNetworkModal />
        </Providers>
      </body>
    </html>
  );
}
