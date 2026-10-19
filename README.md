# kog-top-holder-snapshot

Group the token accounts of a Token 2022 mint by owner at a slot, apply an exclusions file,
rank the holders, and hash the list so two runs can be compared without diffing text.

33 cases on `node:test` and `tsx`. The core is pure: accounts in, snapshot out. The only
network code is the CLI fetch.

```bash
npm install
npm test
npm run build
node dist/cli.js --mint <mint> --top 100 --exclusions exclusions.json --json
```

## Interface

```ts
snapshot({ accounts, exclusions, top, supply? })
// { holders: [{rank, owner, balance, share_pct, accounts}], hash, totals }
```

`accounts` are `{ address, owner, amount }` with `amount` a decimal string in base units.
`exclusions` are `{ address, kind, label? }` where `kind` is one of `curve`, `pool`, `burn`,
`project`, `custom`. `supply` is optional: without it shares are computed against the
included balance, with it they are computed against the supply you name.

## The three properties the job asks for

**The same input gives the same hash.** Amounts are summed with `BigInt`, never a float, so
10 plus 20 is exactly 30. Ordering is total: balance descending, then owner address
ascending. A reversed account list produces the same hash, and the suite asserts it.

**Exclusions are applied.** An excluded owner contributes no holder row and its accounts are
counted in `totals.accounts_excluded`, so a reviewer can see the file was honoured rather
than guessed.

**Ties are broken deterministically.** Two owners on 9000 land in address order, and the
suite checks that the tied pair is sorted rather than in input order.

## What the hash covers

Rank, owner and balance only. Shares are derived, so including them would make the hash
change when only the supply argument changed. The suite asserts that changing `supply`
changes `share_pct` and leaves `hash` alone, and that changing one balance changes `hash`.

## Zero balance accounts

An account holding nothing is not a holder: it is skipped before aggregation, so it neither
inflates a holder's account count nor creates a phantom owner at rank last.

## CLI

`getProgramAccounts` against the Token 2022 program with a memcmp on the mint field and
base64 encoding. The decoder reads the owner at offset 32 and the amount as a little endian
`u64` at offset 64, which is the only part of the account the snapshot needs. The fetch is
injectable, so the two RPC tests run against a stub with no socket: one decodes a real
response shape, one surfaces an rpc error instead of returning an empty list, one refuses a
non 200.

## Mutation check

Returning 0 from the tie-break comparator fails the tie test. Restoring it returns 33
passing.

## House rules

Latin digits, no long dashes, no secrets, no network in the core, integer arithmetic only.

## License

MIT
