"use strict";
/* The balancer (Phase 3): when one side loses on its own horizon, look
   through what the other side could still send for one or two more pieces
   that bring the trade to Fair for it, without tipping the trade so far the
   other way that the giver loses. Single pieces come first, then those that
   only just close the gap, then the ones that cost the giver's starting
   lineup least and help the receiver's most.

   candidates: keys the behind side could get, most valuable first.
   evaluate(keys) -> { gap, otherGap, cost, gain } after adding keys: the
   behind side's gap, the giver's gap, the giver's lineup loss and the
   receiver's lineup gain (points a week, 0 without a linked league).
   fair: the Fair band's edge (verdict.fair_below). */
function findBalancers(candidates, evaluate, fair, max = 3, pairPool = 30) {
  const ok = (r) => r.gap > -fair && r.otherGap > -fair;
  const found = [], short = [];
  for (const k of candidates) {
    const r = evaluate([k]);
    if (ok(r)) found.push({ keys: [k], ...r });
    else if (r.gap <= -fair) short.push(k); // not enough on its own
  }
  /* Pairs only from pieces too small on their own; bigger ones already
     tip the trade by themselves. */
  if (found.length < max) {
    const pool = short.slice(0, pairPool);
    for (let i = 0; i < pool.length; i++)
      for (let j = i + 1; j < pool.length; j++) {
        const r = evaluate([pool[i], pool[j]]);
        if (ok(r)) found.push({ keys: [pool[i], pool[j]], ...r });
      }
  }
  /* Just enough first: the behind side's new gap in bands as wide as Fair,
     so a piece that only just closes the gap beats one that overshoots;
     within a band, the lineup decides. */
  const band = (r) => Math.floor((r.gap + fair) / (2 * fair));
  const lineupScore = (r) => Math.round((r.cost - r.gain) * 2) / 2; // to the nearest half point a week
  found.sort((p, q) => p.keys.length - q.keys.length || band(p) - band(q) || lineupScore(p) - lineupScore(q) || p.gap - q.gap);
  return found.slice(0, max);
}
