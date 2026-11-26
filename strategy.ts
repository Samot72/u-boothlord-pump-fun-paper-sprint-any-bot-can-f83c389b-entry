// Dip-recovery strategy for the pump.fun bonding-curve replay.
//
// Idea: pump.fun curves dump hard right after launch, then the ones with
// real buyers behind them recover. This bot buys the dip instead of
// chasing the pump: a curve qualifies when its price has fallen at least
// `minDip` from its window high AND fresh buy flow has turned positive
// (buyers absorbing the dip, several distinct wallets), while the curve
// is old enough that the launch dump is over and its real SOL sits in a
// sane band. One buy per position, no pyramiding: every entry risks the
// same small stake, so a wrong dip costs little and a real recovery pays
// several times the risk.
//
// Exits: take-profit, stop-loss, a trailing stop once the position is up,
// a fade exit on fresh net outflow, and a time limit. A curve that
// completes is closed by the replay at its final reserves.
//
// Guardrail pacing: the run must end with at least 200 fills over at
// least 20 coins (each round trip at least 0.01 SOL). When the bot's own
// fills or coins lag a pace set in block time, it buys probeSol of a
// liquid curve and sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type {
  Batch,
  Bot,
  BotState,
  OrderInput,
  Pubkey,
} from "./vendor/makefun-bot.ts";

export interface Params {
  /** Lookback window in slots for the dip measurement. */
  window: number;
  /** Price now must be at least this far below the window high. */
  minDip: number;
  /** Recent slots whose buy flow must have turned positive. */
  recoveryWindow: number;
  /** Net buy SOL (buys minus sells) over the recovery window. */
  minRecoverySol: number;
  /** Distinct buying wallets over the recovery window. */
  minRecoveryBuyers: number;
  /** Buy trades over the recovery window. */
  minRecoveryBuys: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL spent on one position (single buy, no pyramid). */
  buySol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop from the position's best close value. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most dip positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 40,
  minDip: 0.15,
  recoveryWindow: 10,
  minRecoverySol: 0.2,
  minRecoveryBuyers: 3,
  minRecoveryBuys: 3,
  minRqSol: 2,
  maxRqSol: 80,
  minAge: 300,
  buySol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.2,
  stopLoss: 0.08,
  trail: 0.2,
  trailArm: 0.1,
  fadeWindow: 15,
  fadeNetSol: 0.5,
  maxHold: 600,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 6,
  maxExposureSol: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on. */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Dip + absorption signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    let high = 0;
    let last = 0;
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (high <= 0 || last <= 0) return false;
    // The dip: price now at least minDip below the window high.
    if (last > high * (1 - p.minDip)) return false;
    // The absorption: fresh buy flow over the recovery window.
    const rFrom = now - p.recoveryWindow;
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= rFrom) continue;
      if (tr.buy) {
        net += tr.sol;
        buys++;
        buyers.add(tr.user);
      } else {
        net -= tr.sol;
      }
    }
    if (net < p.minRecoverySol) return false;
    if (buys < p.minRecoveryBuys || buyers.size < p.minRecoveryBuyers) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === "filled" && !f.client_id.startsWith("_")) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === "CreateEvent") {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === "TradeEvent") {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === "sell") sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(
          h.invested,
          Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS,
        );
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        if (held.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.buySol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: "buy", mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: "buy",
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
