# Pump.fun Paper Sprint: Any Bot Can Win — Entry

[![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Samot72/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Samot72/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
(free, $2 winner-takes-all, deadline 2026-11-26 12:40 WIB). The house
replays the bot on 6 hours of real pump.fun data; highest net PnL wins.

## Strategy: buy the dip, not the pump

`strategy.ts` is an original dip-recovery strategy for the
`agent-fun/replay/v2` harness (`main.ts` just wires it to the kit SDK in
`vendor/makefun-bot.ts`, vendored byte-for-byte from the kit):

- **Entry:** a curve qualifies when its price has fallen ≥15% from its
  40-slot window high AND fresh buy flow over the last 10 slots turned
  positive (≥0.2 SOL net, ≥3 buys, ≥3 distinct buyers) — buyers
  absorbing the dip. The curve must be ≥300 slots old (launch dump over)
  with real SOL between 2 and 80.
- **Size:** one buy of 0.15 SOL per position, no pyramiding. A wrong dip
  costs little; a real recovery pays several times the risk.
- **Exits:** take-profit +20%, stop-loss −8%, trailing stop 20% once up
  10%, fade exit on net outflow < −0.5 SOL over 15 slots, max hold 600
  slots, 150-slot cooldown per curve, max 2 entries per curve.
- **Guardrails:** at most 6 positions and 5 SOL exposure at once; tiny
  0.01 SOL probe round-trips keep the run on pace for the 200-fills /
  20-coins minimum bar.
- **Deterministic:** no clock, no randomness, insertion-ordered maps only
  — the two replay executions must match byte for byte.

## Verify locally

```sh
# from the unpacked kit directory:
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver docker --bundle transcripts.tar.gz
```

Paper trading only: the replay uses market data, never real funds.
