export const dynamic = 'force-static';

const SITE = 'https://trade.mersennet.com';

// '/' is deliberately absent: it 307-redirects to /trade, and listing a
// redirecting URL in the sitemap only confuses crawlers.
const PAGES = [
  { url: '/trade', priority: 1.0, changefreq: 'hourly' },
  { url: '/markets', priority: 0.9, changefreq: 'hourly' },
  { url: '/staking', priority: 0.8, changefreq: 'daily' },
  { url: '/portfolio', priority: 0.8, changefreq: 'daily' },
  { url: '/vault', priority: 0.8, changefreq: 'daily' },
  { url: '/testnet', priority: 0.7, changefreq: 'weekly' },
  { url: '/leaderboard', priority: 0.6, changefreq: 'daily' },
  { url: '/feedback', priority: 0.5, changefreq: 'monthly' },
  { url: '/risk', priority: 0.5, changefreq: 'monthly' },
  { url: '/terms', priority: 0.4, changefreq: 'monthly' },
  { url: '/privacy', priority: 0.4, changefreq: 'monthly' },
];

export function GET() {
  const today = new Date().toISOString().split('T')[0];
  const urls = PAGES.map(
    (p) => `  <url>
    <loc>${SITE}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority.toFixed(2)}</priority>
  </url>`,
  ).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
