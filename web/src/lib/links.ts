/**
 * The one place that knows where users go for testnet MRSN. Every "claim",
 * "faucet" and "get MRSN" link in the terminal resolves through here so the
 * path is the same from the checklist, the account panel, the ticket, the
 * portfolio and the /faucet route: the public faucet with the connected
 * wallet prefilled, which links back to /trade?deposit=1 on success.
 */
export const FAUCET_ORIGIN = 'https://faucet.mersennet.com';

export function faucetUrl(address?: string | null): string {
  const a = address && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : '';
  return a ? `${FAUCET_ORIGIN}/?address=${a}` : `${FAUCET_ORIGIN}/`;
}
