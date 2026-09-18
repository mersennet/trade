/**
 * Roadmap surfaces that exist as routes but are not products yet: they run
 * on simulated or off-chain data. They are reachable by URL only (no menu
 * links) and render behind one shared "Preview" banner so nobody mistakes
 * them for the live terminal. Remove a route from here when it ships.
 */
export const PREVIEW_ROUTES: Record<string, string> = {
  '/spot': 'Spot markets are not on chain yet; nothing here settles.',
  '/options': 'Options are not on chain yet; quotes and fills are simulated.',
  '/otc': 'OTC requests and settlements are simulated; no tokens move.',
  '/copy-trading': 'Copy trading mirrors trades as simulated entries; no orders are submitted.',
  '/ai-agents': 'Agents do not trade live; performance is simulated.',
  '/funding-arb': 'The testnet order book has no funding; the comparison uses sample data.',
  '/competitions': 'Competitions have not started; the weekly sprint on the leaderboard is the live program.',
  '/whales': 'Large-trade feed from the indexer; on the testnet most large prints are the market-making bots.',
  '/governance': 'Proposals here are off-chain drafts; no on-chain voting exists yet.',
  '/sub-accounts': 'Sub-accounts are a labelling tool only; funds stay in your main wallet.',
  '/analytics': 'Personal analytics from indexed fills; some metrics are estimates.',
  '/paper-trading': 'Paper trading uses a virtual balance; nothing is signed or settled.',
};

export function isPreviewRoute(pathname: string | null): boolean {
  return !!pathname && Object.prototype.hasOwnProperty.call(PREVIEW_ROUTES, pathname);
}
