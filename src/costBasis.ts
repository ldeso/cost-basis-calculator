import { formatUnits } from 'viem';
import type { Transfer } from './transfers.js';

export type Method = 'fifo' | 'lifo' | 'average';

export interface Lot {
  amount: bigint;
  pricePerToken: number;
  acquiredAt: number;
  txHash: `0x${string}`;
  source?: 'initial';
}

export interface RealizedSale {
  amount: bigint;
  proceedsUSD: number;
  costUSD: number;
  pnlUSD: number;
  soldAt: number;
  txHash: `0x${string}`;
}

export interface AverageSummary {
  amount: bigint;
  pricePerToken: number;
}

export interface InitialState {
  amount: bigint;          // raw token units
  costBasisUSD: number;    // total USD cost basis for `amount`
  asOf: number;            // ms since epoch; 0 means "unspecified" (not displayed)
}

export const INITIAL_TX_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export interface CostBasisResult {
  method: Method;
  remainingLots: Lot[];           // empty for 'average'
  averageSummary: AverageSummary | null; // populated only for 'average' when amount > 0
  remainingAmount: bigint;
  remainingCostBasisUSD: number;
  realizedProceedsUSD: number;
  realizedCostUSD: number;
  realizedPnLUSD: number;
  realizedSales: RealizedSale[];
  warnings: string[];
}

const PRICE_SCALE_NUM = 1e18;

export function toFloat(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

export function computeCostBasis(
  transfers: Transfer[],
  decimals: number,
  priceFn: (ts: number) => number,
  method: Method,
  initial?: InitialState,
): CostBasisResult {
  const lots: Lot[] = [];
  let lotsHead = 0; // amortized O(1) FIFO drain instead of shift()
  const sales: RealizedSale[] = [];
  const warnings: string[] = [];

  let realizedProceeds = 0;
  let realizedCost = 0;

  let runningHeld = 0n;
  let avgTotalCostScaled = 0n;

  if (initial && initial.amount > 0n) {
    const amountFloat = toFloat(initial.amount, decimals);
    const price = amountFloat > 0 ? initial.costBasisUSD / amountFloat : 0;
    runningHeld += initial.amount;
    if (method === 'average') {
      avgTotalCostScaled += initial.amount * BigInt(Math.round(price * PRICE_SCALE_NUM));
    } else {
      lots.push({
        amount: initial.amount,
        pricePerToken: price,
        acquiredAt: initial.asOf,
        txHash: INITIAL_TX_HASH,
        source: 'initial',
      });
    }
  }

  for (const t of transfers) {
    const price = priceFn(t.timestamp);

    if (t.direction === 'in') {
      if (t.amount === 0n) continue;
      runningHeld += t.amount;
      if (method === 'average') {
        avgTotalCostScaled += t.amount * BigInt(Math.round(price * PRICE_SCALE_NUM));
      } else {
        lots.push({
          amount: t.amount,
          pricePerToken: price,
          acquiredAt: t.timestamp,
          txHash: t.txHash,
        });
      }
      continue;
    }

    if (t.amount === 0n) continue;

    let toSell = t.amount;
    if (toSell > runningHeld) {
      warnings.push(
        `Sold ${toFloat(toSell, decimals)} but only ${toFloat(runningHeld, decimals)} held at ${new Date(t.timestamp).toISOString()} (tx ${t.txHash}). Clamping.`,
      );
      toSell = runningHeld;
    }
    if (toSell === 0n) continue;

    const toSellFloat = toFloat(toSell, decimals);
    const proceeds = toSellFloat * price;
    let cost = 0;

    if (method === 'fifo') {
      let remaining = toSell;
      while (remaining > 0n && lotsHead < lots.length) {
        const lot = lots[lotsHead]!;
        const take = remaining < lot.amount ? remaining : lot.amount;
        cost += toFloat(take, decimals) * lot.pricePerToken;
        lot.amount -= take;
        remaining -= take;
        if (lot.amount === 0n) lotsHead++;
      }
    } else if (method === 'lifo') {
      let remaining = toSell;
      while (remaining > 0n && lots.length > lotsHead) {
        const lot = lots[lots.length - 1]!;
        const take = remaining < lot.amount ? remaining : lot.amount;
        cost += toFloat(take, decimals) * lot.pricePerToken;
        lot.amount -= take;
        remaining -= take;
        if (lot.amount === 0n) lots.pop();
      }
    } else {
      // Average: derive cost directly from running scaled state for precision.
      const costScaled = (toSell * avgTotalCostScaled) / runningHeld;
      cost = Number(costScaled) / PRICE_SCALE_NUM / 10 ** decimals;
      avgTotalCostScaled -= costScaled;
    }

    runningHeld -= toSell;
    if (runningHeld === 0n) avgTotalCostScaled = 0n;

    realizedProceeds += proceeds;
    realizedCost += cost;
    sales.push({
      amount: toSell,
      proceedsUSD: proceeds,
      costUSD: cost,
      pnlUSD: proceeds - cost,
      soldAt: t.timestamp,
      txHash: t.txHash,
    });
  }

  if (method === 'average') {
    const avgPrice =
      runningHeld > 0n
        ? Number(avgTotalCostScaled / runningHeld) / PRICE_SCALE_NUM
        : 0;
    return {
      method,
      remainingLots: [],
      averageSummary:
        runningHeld > 0n ? { amount: runningHeld, pricePerToken: avgPrice } : null,
      remainingAmount: runningHeld,
      remainingCostBasisUSD: toFloat(runningHeld, decimals) * avgPrice,
      realizedProceedsUSD: realizedProceeds,
      realizedCostUSD: realizedCost,
      realizedPnLUSD: realizedProceeds - realizedCost,
      realizedSales: sales,
      warnings,
    };
  }

  const openLots = lots.slice(lotsHead);
  let remainingCost = 0;
  for (const l of openLots) remainingCost += toFloat(l.amount, decimals) * l.pricePerToken;

  return {
    method,
    remainingLots: openLots,
    averageSummary: null,
    remainingAmount: runningHeld,
    remainingCostBasisUSD: remainingCost,
    realizedProceedsUSD: realizedProceeds,
    realizedCostUSD: realizedCost,
    realizedPnLUSD: realizedProceeds - realizedCost,
    realizedSales: sales,
    warnings,
  };
}

