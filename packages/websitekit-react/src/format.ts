import { formatUnits } from 'viem';
import type { SettlementCurrency } from '@websitekit/sdk';

/**
 * An amount in a board's own currency, as a person reads it: `2.5 USDG`, `0.0014 ETH`.
 *
 * The decimals come from the quote and never from a default, because the same integer is two
 * dollars on a 6-decimal board and two trillionths of an ether on an 18-decimal one.
 */
export function formatAmount(amount: bigint, currency: SettlementCurrency): string {
  return `${formatUnits(amount, currency.decimals)} ${currency.symbol}`;
}
