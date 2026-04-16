# Cost Basis Calculator

A single-page, fully client-side calculator that computes the **cost basis**
of an ERC-20 token holding for any account on **Ethereum, Polygon, Base,
Optimism, or Arbitrum**, using FIFO, LIFO, or weighted-average accounting.

Everything runs in the browser. Your Alchemy API key never leaves the page.

## How it works

1. You provide an account address, a token address, pick the chain from the
   dropdown, and paste your `ALCHEMY_API_KEY`. The RPC URL is derived from
   the chain and API key as
   `https://<network>.g.alchemy.com/v2/<ALCHEMY_API_KEY>`.
2. The page fetches every ERC-20 transfer in/out of the account for the
   given token via `alchemy_getAssetTransfers`.
3. It fetches daily historical USD prices for the token from Alchemy's
   Prices API (using the selected chain as the `network` parameter).
4. It replays the transfers in chronological order and computes:
   - **Remaining holdings** and their cost basis,
   - **Realized proceeds**, **realized cost**, and **realized P&L** from
     outgoing transfers (treated as sales at the price-at-time).

## Build

The runtime dependency is **viem** only. `typescript` and `esbuild` are
build-time tools.

```sh
npm install
npm run build       # type-check, then bundle src/main.ts → dist/bundle.js
```

The output is two static files: `index.html` and `dist/bundle.js`. Drop
them on any static host (GitHub Pages, IPFS, S3, `python3 -m http.server`).

## Run locally

```sh
npm run build
npm run serve       # python3 -m http.server 8000
# open http://localhost:8000
```

## Smoke test (optional, Node)

`test/smoke.ts` exercises the same pipeline from the command line with
your env vars, useful when iterating on the algorithm:

```sh
export ALCHEMY_API_KEY=YOUR_KEY
export CHAIN=base   # or ethereum, polygon, optimism, arbitrum
npx esbuild test/smoke.ts --bundle --format=esm --platform=node \
  --target=node20 --outfile=test/smoke.bundle.mjs
node test/smoke.bundle.mjs <account> [token] [fifo|lifo|average]
```

## Seeding an initial cost basis (e.g. after a token migration)

The "Initial state (optional)" fieldset lets you start the replay from a
pre-existing balance with a known cost basis instead of from zero. The
typical use case is a **token migration**: compute the cost basis of the
old token, then carry the last remaining amount and remaining USD cost
basis forward as the starting point for the new token.

Fields:
- **Initial amount** — pre-existing balance in the new token's units
  (decimal).
- **Initial cost basis (USD)** — total USD cost attributed to that
  balance. The per-token price of the seeded lot is derived as
  `cost basis / amount`.
- **Start date (UTC, optional)** — transfers strictly before this date
  are excluded. Use a date on or after the migration so the migration-in
  transfer of the new token is not double-counted against the seeded
  balance.

Behaviour:
- FIFO/LIFO: one synthetic "initial" lot is pushed first. It is consumed
  before any real lot under FIFO, and after every real lot under LIFO.
- Weighted average: the seeded balance and cost are folded into the
  running average before the first transfer is processed.
- When an initial amount is seeded, the computed remaining amount is
  expected to exceed the on-chain `balanceOf` unless you also set a
  start date that excludes the pre-existing balance's origin transfer.

## Notes & limitations

- Requires an **Alchemy** API key because `alchemy_getAssetTransfers` is a
  custom Alchemy method (the standard `eth_getLogs` is capped to 10 blocks
  on the Alchemy free tier and would not work for whole-history scans).
  The key needs to be enabled on whichever of Ethereum, Polygon, Base,
  Optimism, or Arbitrum you want to query.
- USD prices are sampled at **daily granularity** (`1d` interval). For most
  cost-basis use cases this is appropriate; very high-frequency intraday
  moves are smoothed.
- For tokens not covered by Alchemy's price feed on the selected chain, the
  prices request fails and the calculator stops with an error.
- Outgoing transfers are treated as taxable disposals at the
  price-at-time. If you transfer between your own wallets, the calculator
  does **not** know — it will record a sale.
- Tokens with non-standard transfer mechanics (rebases, transfer fees) may
  show a mismatch between computed remaining amount and on-chain
  `balanceOf`; the UI flags this.

## License

MIT — see [LICENSE](LICENSE).
