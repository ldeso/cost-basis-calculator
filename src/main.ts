import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { CHAINS, isChainKey, rpcUrlFor, type ChainConfig } from './chains.js';
import { fetchTransfers, type Transfer } from './transfers.js';
import { fetchHistoricalPrices, MS_PER_DAY, priceAt } from './prices.js';
import {
  computeCostBasis,
  toFloat,
  INITIAL_TX_HASH,
  type CostBasisResult,
  type InitialState,
  type Method,
} from './costBasis.js';

const DEFAULT_METHOD: Method = 'fifo';

const FORM_FIELDS = [
  'account',
  'token',
  'chain',
  'alchemyKey',
  'method',
  'initialAmount',
  'initialCostBasis',
  'startDate',
] as const;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function loadFormFromStorage() {
  for (const f of FORM_FIELDS) {
    const stored = sessionStorage.getItem(`cbc:${f}`);
    if (stored == null) continue;
    if (f === 'method') {
      const radio = document.querySelector<HTMLInputElement>(
        `input[name="method"][value="${stored}"]`,
      );
      if (radio) radio.checked = true;
    } else if (f === 'chain') {
      if (isChainKey(stored)) ($(f) as HTMLSelectElement).value = stored;
    } else if (f === 'startDate') {
      // Upgrade pre-existing "YYYY-MM-DD" values to the datetime-local format.
      const normalized = stored.length === 10 ? `${stored}T00:00:00` : stored;
      ($(f) as HTMLInputElement).value = normalized;
    } else {
      ($(f) as HTMLInputElement).value = stored;
    }
  }
}

function saveFormToStorage() {
  for (const f of FORM_FIELDS) {
    if (f === 'method') {
      const checked = document.querySelector<HTMLInputElement>(
        'input[name="method"]:checked',
      );
      if (checked) sessionStorage.setItem(`cbc:${f}`, checked.value);
    } else if (f === 'chain') {
      sessionStorage.setItem(`cbc:${f}`, ($(f) as HTMLSelectElement).value);
    } else {
      sessionStorage.setItem(`cbc:${f}`, ($(f) as HTMLInputElement).value);
    }
  }
}

function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

function fmtUSD(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtAmount(amount: bigint, decimals: number): string {
  const s = formatUnits(amount, decimals);
  const n = Number(s);
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(4);
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function fmtDate(ts: number): string {
  // YYYY-MM-DD HH:MM (UTC). Shown so intra-day ordering is visible when the
  // user sets a sub-day start cutoff.
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

function shortHash(h: `0x${string}`): string {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function txLink(chain: ChainConfig, h: `0x${string}`): string {
  return `${chain.explorerTxBase}/${h}`;
}

function renderResult(
  result: CostBasisResult,
  chain: ChainConfig,
  symbol: string,
  decimals: number,
  liveBalance: bigint,
  seeded: boolean,
) {
  const out = $('results');
  const method = result.method;

  const balanceMismatch = result.remainingAmount !== liveBalance;
  const mismatchReason = seeded
    ? 'This is expected when seeding an initial state unless the start date excludes the origin of that balance; otherwise the token may have non-standard transfer logic (rebases, fees, etc.).'
    : 'The token may have non-standard transfer logic (rebases, fees, etc.).';
  const mismatchHTML = balanceMismatch
    ? `<p class="warn">⚠ Computed balance ${fmtAmount(result.remainingAmount, decimals)} ${symbol} differs from on-chain balance ${fmtAmount(liveBalance, decimals)} ${symbol}. ${mismatchReason}</p>`
    : '';

  const warningsHTML =
    result.warnings.length === 0
      ? ''
      : `<div class="warn"><strong>Warnings:</strong><ul>${result.warnings
          .map((w) => `<li>${w}</li>`)
          .join('')}</ul></div>`;

  const lotRow = (
    acquired: string,
    amount: bigint,
    price: number,
    tx: string,
  ): string => {
    const usd = toFloat(amount, decimals) * price;
    return `<tr>
      <td>${acquired}</td>
      <td class="num">${fmtAmount(amount, decimals)}</td>
      <td class="num">${fmtUSD(price)}</td>
      <td class="num">${fmtUSD(usd)}</td>
      <td>${tx}</td>
    </tr>`;
  };

  let lotsRows: string;
  if (result.averageSummary) {
    const s = result.averageSummary;
    lotsRows = lotRow('—', s.amount, s.pricePerToken, '<span class="muted">averaged</span>');
  } else if (result.remainingLots.length === 0) {
    lotsRows = `<tr><td colspan="5" class="muted">No remaining holdings.</td></tr>`;
  } else {
    lotsRows = result.remainingLots
      .map((l) => {
        const isInitial = l.source === 'initial' || l.txHash === INITIAL_TX_HASH;
        const dateCell = isInitial
          ? l.acquiredAt > 0
            ? `${fmtDate(l.acquiredAt)} <span class="muted">(initial)</span>`
            : '<span class="muted">initial</span>'
          : fmtDate(l.acquiredAt);
        const txCell = isInitial
          ? '<span class="muted">seeded</span>'
          : `<a href="${txLink(chain, l.txHash)}" target="_blank" rel="noopener">${shortHash(l.txHash)}</a>`;
        return lotRow(dateCell, l.amount, l.pricePerToken, txCell);
      })
      .join('');
  }

  const salesRows =
    result.realizedSales.length === 0
      ? `<tr><td colspan="6" class="muted">No outgoing transfers.</td></tr>`
      : result.realizedSales
          .map(
            (s) => `<tr>
              <td>${fmtDate(s.soldAt)}</td>
              <td class="num">${fmtAmount(s.amount, decimals)}</td>
              <td class="num">${fmtUSD(s.proceedsUSD)}</td>
              <td class="num">${fmtUSD(s.costUSD)}</td>
              <td class="num ${s.pnlUSD >= 0 ? 'pos' : 'neg'}">${fmtUSD(s.pnlUSD)}</td>
              <td><a href="${txLink(chain, s.txHash)}" target="_blank" rel="noopener">${shortHash(s.txHash)}</a></td>
            </tr>`,
          )
          .join('');

  const closedRow = (l: typeof result.closedLots[number]): string => {
    const isInitial = l.source === 'initial' || l.txHash === INITIAL_TX_HASH;
    const acquired = isInitial
      ? l.acquiredAt > 0
        ? `${fmtDate(l.acquiredAt)} <span class="muted">(initial)</span>`
        : '<span class="muted">initial</span>'
      : fmtDate(l.acquiredAt);
    const closedCell =
      l.firstSoldAt === l.lastSoldAt
        ? fmtDate(l.lastSoldAt)
        : `${fmtDate(l.firstSoldAt)}&nbsp;→&nbsp;${fmtDate(l.lastSoldAt)}`;
    const costUsd = toFloat(l.originalAmount, decimals) * l.pricePerToken;
    const pnl = l.proceedsUSD - costUsd;
    const txCell = isInitial
      ? '<span class="muted">seeded</span>'
      : `<a href="${txLink(chain, l.txHash)}" target="_blank" rel="noopener">${shortHash(l.txHash)}</a>`;
    return `<tr>
      <td>${acquired}</td>
      <td>${closedCell}</td>
      <td class="num">${fmtAmount(l.originalAmount, decimals)}</td>
      <td class="num">${fmtUSD(l.pricePerToken)}</td>
      <td class="num">${fmtUSD(costUsd)}</td>
      <td class="num">${fmtUSD(l.proceedsUSD)}</td>
      <td class="num ${pnl >= 0 ? 'pos' : 'neg'}">${fmtUSD(pnl)}</td>
      <td>${txCell}</td>
    </tr>`;
  };

  const closedLotsHTML = result.averageSummary
    ? ''
    : `
    <details class="section">
      <summary>Closed lots</summary>
      <table>
        <thead><tr><th>Acquired</th><th>Closed</th><th>Amount</th><th>Price/token</th><th>Cost</th><th>Proceeds</th><th>P&amp;L</th><th>Tx</th></tr></thead>
        <tbody>${
          result.closedLots.length === 0
            ? `<tr><td colspan="8" class="muted">No fully consumed lots.</td></tr>`
            : result.closedLots.map(closedRow).join('')
        }</tbody>
      </table>
    </details>`;

  out.innerHTML = `
    <h2>${symbol} — ${method.toUpperCase()}</h2>
    ${mismatchHTML}
    ${warningsHTML}
    <table class="totals">
      <tr><td>Remaining amount</td><td class="num">${fmtAmount(result.remainingAmount, decimals)} ${symbol}</td></tr>
      <tr><td>Remaining cost basis</td><td class="num">${fmtUSD(result.remainingCostBasisUSD)}</td></tr>
      <tr><td>Realized proceeds</td><td class="num">${fmtUSD(result.realizedProceedsUSD)}</td></tr>
      <tr><td>Realized cost</td><td class="num">${fmtUSD(result.realizedCostUSD)}</td></tr>
      <tr><td>Realized P&amp;L</td><td class="num ${result.realizedPnLUSD >= 0 ? 'pos' : 'neg'}">${fmtUSD(result.realizedPnLUSD)}</td></tr>
    </table>

    <details class="section" open>
      <summary>Open lots</summary>
      <table>
        <thead><tr><th>Acquired</th><th>Amount</th><th>Price/token</th><th>Cost basis</th><th>Tx</th></tr></thead>
        <tbody>${lotsRows}</tbody>
      </table>
    </details>
    ${closedLotsHTML}

    <details class="section" open>
      <summary>Realized sales</summary>
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Proceeds</th><th>Cost</th><th>P&amp;L</th><th>Tx</th></tr></thead>
        <tbody>${salesRows}</tbody>
      </table>
    </details>
  `;
}

async function run() {
  saveFormToStorage();
  $('results').innerHTML = '';

  const account = ($('account') as HTMLInputElement).value.trim();
  const token = ($('token') as HTMLInputElement).value.trim();
  const chainKey = ($('chain') as HTMLSelectElement).value;
  const alchemyKey = ($('alchemyKey') as HTMLInputElement).value.trim();
  const method = (
    document.querySelector<HTMLInputElement>('input[name="method"]:checked')
      ?.value ?? DEFAULT_METHOD
  ) as Method;
  const initialAmountStr = ($('initialAmount') as HTMLInputElement).value.trim();
  const initialCostStr = ($('initialCostBasis') as HTMLInputElement).value.trim();
  const startDateStr = ($('startDate') as HTMLInputElement).value.trim();

  if (!isAddress(account)) {
    setStatus('Invalid account address.', 'error');
    return;
  }
  if (!isAddress(token)) {
    setStatus('Invalid token address.', 'error');
    return;
  }
  if (!isChainKey(chainKey)) {
    setStatus('Invalid chain selection.', 'error');
    return;
  }
  if (!alchemyKey) {
    setStatus('ALCHEMY_API_KEY is required.', 'error');
    return;
  }

  let startMsFilter: number | null = null;
  if (startDateStr) {
    // datetime-local format: "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS".
    // Treat the entered value as UTC.
    const isoUtc =
      startDateStr.length === 10
        ? `${startDateStr}T00:00:00Z`
        : startDateStr.length === 16
          ? `${startDateStr}:00Z`
          : `${startDateStr}Z`;
    const parsed = Date.parse(isoUtc);
    if (Number.isNaN(parsed)) {
      setStatus('Invalid start time.', 'error');
      return;
    }
    startMsFilter = parsed;
  }

  const initialCostUSD = initialCostStr ? Number(initialCostStr) : 0;
  if (initialCostStr && !Number.isFinite(initialCostUSD)) {
    setStatus('Invalid initial cost basis.', 'error');
    return;
  }
  if (initialCostUSD < 0) {
    setStatus('Initial cost basis must be non-negative.', 'error');
    return;
  }
  if (initialAmountStr && !/^\d+(\.\d+)?$/.test(initialAmountStr)) {
    setStatus('Invalid initial amount (use a non-negative decimal).', 'error');
    return;
  }
  const chain = CHAINS[chainKey];
  const rpcUrl = rpcUrlFor(chain, alchemyKey);

  const button = $('go') as HTMLButtonElement;
  button.disabled = true;

  try {
    const client = createPublicClient({
      chain: chain.viemChain,
      transport: http(rpcUrl),
    }) as PublicClient;

    setStatus('Reading token metadata…');
    const tokenAddr = token as Address;
    const accountAddr = account as Address;
    const [decimalsRaw, symbol, liveBalance] = await Promise.all([
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({
        address: tokenAddr,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [accountAddr],
      }),
    ]);
    const decimals = Number(decimalsRaw);

    let initial: InitialState | undefined;
    if (initialAmountStr) {
      try {
        const amt = parseUnits(initialAmountStr, decimals);
        if (amt > 0n) {
          initial = {
            amount: amt,
            costBasisUSD: initialCostUSD,
            asOf: startMsFilter ?? 0,
          };
        }
      } catch {
        setStatus('Initial amount has too many decimals for this token.', 'error');
        return;
      }
    } else if (initialCostUSD > 0) {
      setStatus(
        'Initial cost basis set without an initial amount. Leave both blank or fill both.',
        'error',
      );
      return;
    }

    const allTransfers = await fetchTransfers(client, tokenAddr, accountAddr, setStatus);
    const transfers: Transfer[] =
      startMsFilter != null
        ? allTransfers.filter((t) => t.timestamp >= startMsFilter!)
        : allTransfers;
    const skipped = allTransfers.length - transfers.length;

    if (transfers.length === 0 && !initial) {
      setStatus(
        skipped > 0
          ? `No transfers on or after the start date (${skipped} earlier transfers skipped).`
          : 'No transfers found for this account/token.',
        'info',
      );
      renderResult(
        computeCostBasis([], decimals, () => 0, method, initial),
        chain,
        symbol,
        decimals,
        liveBalance,
        initial != null,
      );
      return;
    }

    let prices: Awaited<ReturnType<typeof fetchHistoricalPrices>> = [];
    if (transfers.length > 0) {
      const startMs = transfers[0]!.timestamp - MS_PER_DAY;
      const endMs = transfers[transfers.length - 1]!.timestamp + MS_PER_DAY;
      prices = await fetchHistoricalPrices(
        alchemyKey,
        chain.pricesNetwork,
        tokenAddr,
        startMs,
        endMs,
        setStatus,
      );

      if (prices.length === 0) {
        setStatus(
          'No price data returned by Alchemy for this token. Cannot compute USD cost basis.',
          'error',
        );
        return;
      }
    }

    setStatus(
      `Computing cost basis from ${transfers.length} transfers and ${prices.length} price points${
        skipped > 0 ? ` (${skipped} earlier transfers skipped)` : ''
      }${initial ? ' with seeded initial state' : ''}…`,
    );
    const result = computeCostBasis(
      transfers,
      decimals,
      (ts) => priceAt(prices, ts),
      method,
      initial,
    );

    renderResult(result, chain, symbol, decimals, liveBalance, initial != null);
    setStatus(
      `Done. ${transfers.length} transfers processed, ${result.realizedSales.length} sales realized${
        skipped > 0 ? `, ${skipped} skipped` : ''
      }${initial ? ', initial state seeded' : ''}.`,
    );
  } catch (err) {
    console.error(err);
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadFormFromStorage();
  ($('form') as HTMLFormElement).addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
});
