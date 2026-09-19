#!/usr/bin/env node
/**
 * Browser smoke for the trade terminal. Loads the pages a first visitor hits,
 * on a desktop and a phone viewport, and fails the deploy when:
 *   - a page throws (uncaught error / console.error we do not allow-list),
 *   - the app error boundary or Next's error page renders,
 *   - a page whose content is taller than the viewport cannot be scrolled
 *     (the 18 Sep regression: fixed-height column on every route),
 *   - a page-defining element is missing (connect button, staking table…),
 *   - a request to our own origin answers 5xx.
 *
 *   node smoke.mjs <base-url>            e.g. http://127.0.0.1:8090 (deploy preview) or https://trade.mersennet.com
 *
 * Exit 0 = ship it. Exit 1 = keep the old container. Prints one line per check.
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://127.0.0.1:8090').replace(/\/$/, '');
const PAGES = [
  { path: '/trade', must: ['button:has-text("Connect Wallet")', 'text=/Long/i'], fixedDesktop: true },
  { path: '/markets', must: ['text=/MRSN/'] },
  { path: '/portfolio', must: ['button:has-text("Connect")'] },
  { path: '/vault', must: ['text=/Maker Vault/i', 'text=/Deposit/i'] },
  { path: '/leaderboard', must: ['text=/Leaderboard/i'] },
  { path: '/points', must: ['text=/Points/i'] },
  { path: '/staking', must: ['text=/Validator set/i', 'button:has-text("Delegate")'] },
  { path: '/testnet', must: ['text=/faucet/i'] },
  { path: '/api', must: ['text=/REST Endpoints/i'] },
  { path: '/options', must: ['text=/Preview/i'] },
];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
];
// Console noise that is not ours (wallet extensions, WalletConnect relay, TradingView).
const IGNORE = [/walletconnect|reown|web3modal/i, /tradingview/i, /favicon/i, /ResizeObserver loop/i, /net::ERR_BLOCKED_BY_CLIENT/i, /hydration.*email-protection/i, /Failed to load resource.*(429|404)/i,
  /Object is disposed/i /* Playwright teardown race, not the page */];

const failures = [];
const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: 1 });
  for (const p of PAGES) {
    let attempt = 0, lastErr = null;
    while (attempt < 2) {
    attempt++;
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => { if (!IGNORE.some((re) => re.test(e.message))) errors.push(`pageerror: ${e.message}`); });
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.some((re) => re.test(m.text()))) errors.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('response', (r) => { const u = r.url(); if (u.startsWith(BASE) && r.status() >= 500) errors.push(`${r.status()} ${u.replace(BASE, '')}`); });
    const label = `${vp.name.padEnd(7)} ${p.path}`;
    try {
      const res = await page.goto(BASE + p.path, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res && res.status()}`);
      await page.waitForTimeout(3500); // data fetches, hydration
      const body = await page.evaluate(() => document.body.innerText);
      if (/Application error|Something went wrong|This page could not be found/i.test(body)) throw new Error('error page rendered');
      for (const sel of p.must) {
        const n = await page.locator(sel).first().count();
        if (!n) throw new Error(`missing ${sel}`);
      }
      // Scroll check: when content overflows the viewport, the page must move.
      const fixed = p.fixedDesktop && vp.name === 'desktop';
      if (!fixed) {
        const r = await page.evaluate(() => {
          const se = document.scrollingElement;
          const overflow = se.scrollHeight > innerHeight + 40;
          if (!overflow) return { overflow, moved: true };
          window.scrollTo(0, 400);
          return { overflow, moved: (se.scrollTop || window.scrollY) > 0 };
        });
        if (r.overflow && !r.moved) throw new Error('content overflows but the page does not scroll');
      }
      if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
      console.log(`ok    ${label}${attempt > 1 ? ' (on retry)' : ''}`);
      lastErr = null;
      await page.close();
      break;
    } catch (e) {
      lastErr = e;
      await page.close();
      if (attempt < 2) { console.log(`retry ${label}: ${e.message}`); continue; }
      failures.push(`${label}: ${e.message}`);
      console.log(`FAIL  ${label}: ${e.message}`);
    }
    }
  }
  await ctx.close();
}
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failure(s) — not deploying.`);
  process.exit(1);
}
console.log(`\nall ${PAGES.length * VIEWPORTS.length} checks passed`);
