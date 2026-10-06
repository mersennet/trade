// Rules for dropping TP/SL brackets whose position is gone: runs
// pruneClosedBrackets() from src/hooks/useBrackets.ts against a stubbed store,
// chain and API with a controllable clock.  node scripts/test-brackets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hooks', 'useBrackets.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

let now = 1_000_000;
const RealDate = Date;
global.Date = class extends RealDate { static now() { return now; } };

function load(env) {
  const stubs = {
    react: { useEffect() {} },
    '@/stores/useStore': { useStore: { getState: () => env.state } },
    '@/hooks/useWallet': { useWallet() {} },
    '@/components/shared/Toast': { useToast() {} },
    '@/lib/positions': { livePositionSize: async (_o, m) => (m in env.live ? env.live[m] : 0) },
    '@/lib/api': { api: { getOrders: async () => { env.ordersCalls++; if (env.ordersFail) throw new Error('down'); return { orders: env.resting.map((m) => ({ market_id: m })) }; } } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)((n) => { if (!(n in stubs)) throw new Error('unexpected import ' + n); return stubs[n]; }, mod, mod.exports);
  return mod.exports;
}

function makeEnv(brackets) {
  const env = { live: {}, resting: [], ordersFail: false, ordersCalls: 0, notes: [] };
  env.state = {
    brackets: brackets.map((b) => ({ ...b })),
    setBracket(b) { this.brackets = [...this.brackets.filter((x) => !(x.owner === b.owner && x.marketId === b.marketId)), b]; },
    removeBracket(id) { this.brackets = this.brackets.filter((x) => x.id !== id); },
    addNotification(kind, title, body) { env.notes.push(`${title}: ${body}`); },
  };
  return env;
}

const OWNER = '0xAbC0000000000000000000000000000000000001';
const br = (marketId, isLong, ageMs, extra = {}) => ({ id: `${OWNER.toLowerCase()}-${marketId}`, owner: OWNER, marketId, isLong, size: '5', tp: '110', sl: '90', ts: now - ageMs, ...extra });

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
}
const has = (env, m) => env.state.brackets.some((b) => b.marketId === m);

(async () => {
  {
    const env = makeEnv([br(1, true, 5_000)]); const m = load(env);
    env.live[1] = 5;
    await m.pruneClosedBrackets(OWNER);
    check('open position: bracket kept and marked seenOpen', has(env, 1) && env.state.brackets[0].seenOpen === true);
  }
  {
    const env = makeEnv([br(1, true, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[1] = 0;
    await m.pruneClosedBrackets(OWNER);
    check('closed after seen open: one flat read keeps it (stale-origin guard)', has(env, 1));
    now += 4_000; await m.pruneClosedBrackets(OWNER);
    check('closed after seen open: second flat read 4 s later still keeps it', has(env, 1));
    now += 5_000; await m.pruneClosedBrackets(OWNER);
    check('closed after seen open: flat 9 s apart removes it, one notification', !has(env, 1) && env.notes.length === 1, JSON.stringify(env.notes));
  }
  {
    const env = makeEnv([br(1, true, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[1] = 0; await m.pruneClosedBrackets(OWNER);
    now += 3_000; env.live[1] = 5; await m.pruneClosedBrackets(OWNER);
    now += 9_000; env.live[1] = 0; await m.pruneClosedBrackets(OWNER);
    check('a flat read followed by an open read resets the confirmation', has(env, 1));
  }
  {
    const env = makeEnv([br(2, true, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[2] = -3; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('long bracket on a flipped (short) position is removed', !has(env, 2));
  }
  {
    const env = makeEnv([br(3, false, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[3] = -2; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('short bracket on an open short is kept', has(env, 3));
  }
  {
    const env = makeEnv([br(1, true, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[1] = null; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('chain does not answer: kept', has(env, 1));
  }
  {
    const env = makeEnv([br(1, true, 30_000)]); const m = load(env);
    env.live[1] = 0; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('never seen open, under a minute old (order may still fill): kept, no API call', has(env, 1) && env.ordersCalls === 0);
  }
  {
    const env = makeEnv([br(1, true, 120_000)]); const m = load(env);
    env.live[1] = 0; env.resting = [1]; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('never seen open, old, its order still rests: kept', has(env, 1));
  }
  {
    const env = makeEnv([br(1, true, 120_000)]); const m = load(env);
    env.live[1] = 0; env.resting = [4]; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('never seen open, old, no order on its market (cancelled): removed', !has(env, 1));
  }
  {
    const env = makeEnv([br(1, true, 120_000)]); const m = load(env);
    env.live[1] = 0; env.ordersFail = true; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('never seen open, old, orders API down: kept', has(env, 1));
  }
  {
    const env = makeEnv([br(1, true, 5_000, { seenOpen: true }), br(2, true, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[1] = 0; env.live[2] = 0;
    await m.pruneClosedBrackets(OWNER, 1); now += 9_000; await m.pruneClosedBrackets(OWNER, 1);
    check('market filter: only the given market is pruned', !has(env, 1) && has(env, 2));
  }
  {
    const other = '0xDEF0000000000000000000000000000000000002';
    const env = makeEnv([{ ...br(1, true, 5_000, { seenOpen: true }), id: 'x', owner: other }]); const m = load(env);
    env.live[1] = 0; await m.pruneClosedBrackets(OWNER); now += 9_000; await m.pruneClosedBrackets(OWNER);
    check("another wallet's bracket is never touched", env.state.brackets.length === 1);
  }
  {
    const env = makeEnv([br(1, true, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[1] = 0; await m.pruneClosedBrackets(OWNER);
    env.state.setBracket({ ...br(1, true, 0), ts: now + 1 });
    now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('a bracket replaced (new TP/SL) meanwhile restarts its own checks', has(env, 1));
  }
  {
    const env = makeEnv([br(1, true, 5_000, { seenOpen: true })]); const m = load(env);
    env.live[1] = 0; await m.pruneClosedBrackets(OWNER);
    env.state.setBracket({ ...br(1, true, 120_000) });
    now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('replacement inherits no flat reading from the bracket it replaced', has(env, 1));
    now += 9_000; await m.pruneClosedBrackets(OWNER);
    check('replacement goes after its own two flat readings', !has(env, 1));
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
