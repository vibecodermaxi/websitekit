import { formatEther } from 'viem';
import {
  computeSplit,
  computeTakePrice,
  economicsFromTerms,
  type SiteTerms,
  type SlotState,
} from '@websitekit/sdk';

import type { ExampleMeta } from '../../../lib/sites';

/**
 * What this board pays the person who owns the site.
 *
 * The one thing the pages could not say before: a dev looking at a websitekit site can see that slots
 * are owned and priced, and still have no idea what any of it is worth to *them*. This answers it
 * per slot, in ETH, from live chain state.
 *
 * **Every number here comes from `computeSplit`, the same function the contract's split is mirrored
 * from.** Nothing is a hardcoded multiplier and nothing is an estimate dressed up as a fact:
 *
 *   next sale   — `computeSplit(effectiveFloor, price, isUnclaimed, …).siteCut`, using the slot's
 *                 CURRENT on-chain effective floor and price. This is exactly what the treasury is
 *                 credited if somebody buys this slot in the next block. No assumptions at all.
 *   every resale — the same split recomputed at the slot's floor, which is the steady state a slot
 *                 returns to once decay has run its course. This one IS a projection, and it is
 *                 labelled as one.
 *
 * The distinction matters because they diverge: a slot someone just paid 1.6x for is sitting above
 * its floor, so its next sale pays more than its steady state will. Showing only the high number
 * would be the same overclaim the payout correction already had to walk back once.
 */
export function Earnings({
  example,
  slots,
  terms,
}: {
  example: ExampleMeta;
  slots: SlotState[];
  terms: SiteTerms;
}) {
  // `economicsFromTerms` rather than a spread written out here. The SDK carries it precisely
  // because these are five similarly-named `bigint`s: transposing two of them type-checks, runs,
  // and produces a quote that is merely wrong.
  const economics = economicsFromTerms(terms);

  const rows = slots.map((slot) => {
    // What the treasury is credited if this slot sells right now, whoever buys it and however.
    const now = computeSplit(
      slot.effectiveFloor,
      slot.charged,
      slot.isUnclaimed,
      economics.payoutBps,
      economics.protocolBps,
    );

    // The steady state: a slot sitting at its floor, taken. `computeTakePrice` rather than
    // `floor * takeBps / 10_000` by hand, so the truncation happens where the contract does it.
    const atFloor = computeTakePrice(
      slot.floor,
      slot.floor,
      0n,
      economics.reversionBps,
      economics.takeBps,
      economics.maxReversionWeeks,
    );
    const steady = computeSplit(
      atFloor.effectiveFloor,
      atFloor.price,
      false,
      economics.payoutBps,
      economics.protocolBps,
    );

    return { slot, now: now.siteCut, steady: steady.siteCut };
  });

  const openRows = rows.filter((row) => row.slot.isUnclaimed);
  const ifAllSoldOnce = rows.reduce((total, row) => total + row.now, 0n);
  const perRoundOfResales = rows.reduce((total, row) => total + row.steady, 0n);

  return (
    <section className="earn">
      <div className="earn-inner">
        <h2>What this board pays its owner</h2>
        <p className="earn-intro">
          Every figure is computed from this contract&rsquo;s live state with{' '}
          <code>computeSplit</code> from <code>@websitekit/sdk</code> — the same split the chain
          performs. Terms are frozen at <code>{example.terms}</code>.
        </p>

        <div className="earn-heads">
          <div>
            <span className="k">If every slot sold once, right now</span>
            <strong>{formatEther(ifAllSoldOnce)} ETH</strong>
          </div>
          <div>
            <span className="k">Then per full round of resales, at floor</span>
            <strong>{formatEther(perRoundOfResales)} ETH</strong>
          </div>
          <div>
            <span className="k">Open slots anyone can claim today</span>
            <strong>
              {openRows.length} of {rows.length}
            </strong>
          </div>
        </div>

        <div className="earn-scroll">
          <table>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Status</th>
                <th className="r">Floor</th>
                <th className="r">Next sale pays you</th>
                <th className="r">Every resale, at floor</th>
                <th className="r">Sales so far</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ slot, now, steady }) => (
                <tr key={slot.key} className={slot.isUnclaimed ? 'is-open' : undefined}>
                  <td className="key">{slot.key}</td>
                  <td>
                    <span className={slot.isUnclaimed ? 'pill open' : 'pill owned'}>
                      {slot.isUnclaimed ? 'open' : 'owned'}
                    </span>
                  </td>
                  <td className="r">{formatEther(slot.floor)}</td>
                  <td className="r strong">{formatEther(now)}</td>
                  <td className="r dim">{formatEther(steady)}</td>
                  <td className="r dim">{slot.takes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="earn-foot">
          &ldquo;Next sale&rdquo; is exact — it uses the slot&rsquo;s current effective floor and
          price. &ldquo;Every resale&rdquo; is a projection at the floor, which is where a slot ends
          up once decay has run. A slot someone just paid a premium for sits above its floor, so the
          two diverge, and the second number is the one that holds in the long run.
        </p>
      </div>
    </section>
  );
}
