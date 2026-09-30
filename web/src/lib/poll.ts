/**
 * Polite polling: a setTimeout chain instead of setInterval, with
 *
 *  - ±20% jitter so many components/tabs never fire in lockstep (the REST
 *    stampede when the WS drops was every poller waking on the same tick),
 *  - exponential backoff (up to 8× base) while the poll fn keeps rejecting,
 *    so a recovering API isn't hammered at full cadence,
 *  - a pause while the tab is hidden — background tabs contribute nothing
 *    and were a large share of total API load.
 *
 * Returns a stop() cleanup for useEffect.
 */
export function startPoll(fn: () => Promise<unknown> | unknown, baseMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  // One request at a time: a tab shown again mid-request used to start a second
  // chain, and every such switch left the endpoint polled once more per period.
  let inFlight = false;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const backoff = Math.min(2 ** failures, 8);
    const jitter = 0.8 + Math.random() * 0.4;
    timer = setTimeout(tick, baseMs * backoff * jitter);
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    timer = null;
    if (typeof document !== 'undefined' && document.hidden) {
      // Skip the request but keep the chain alive at base cadence.
      schedule();
      return;
    }
    inFlight = true;
    try {
      await fn();
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      inFlight = false;
    }
    schedule();
  };

  // The first poll is one period out; callers make their own initial request.
  schedule();

  // Resume promptly when the tab becomes visible again (a request in flight
  // reschedules itself when it lands).
  const onVisible = () => {
    if (stopped || inFlight || typeof document === 'undefined' || document.hidden) return;
    if (timer) clearTimeout(timer);
    void tick();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}
