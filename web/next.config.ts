import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',

  async headers() {
    return [
      {
        // HTML pages must revalidate on every load: the page references
        // content-hashed JS chunks, so fresh HTML always pulls the current
        // bundle. Without this the app served `s-maxage=31536000` on HTML and
        // browsers kept running days-old code after deploys.
        // Matches page routes only (no file extensions, no _next/static).
        source: '/:path((?!_next/static|.*\\..*).*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
