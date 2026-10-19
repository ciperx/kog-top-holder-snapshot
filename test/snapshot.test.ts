import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  SnapshotError,
  decodeTokenAccount,
  encodeBase58,
  hashHolders,
  parseExclusions,
  snapshot,
  type TokenAccount,
} from "../src/snapshot.js";
import { fetchAccounts, parseCli } from "../src/cli.js";

interface Fixture {
  accounts: TokenAccount[];
  exclusions: Array<{ address: string; kind: string; label?: string }>;
  owners: Record<string, string>;
}

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/accounts.json", import.meta.url), "utf8"),
) as Fixture;

const base = () => ({ accounts: fixture.accounts, exclusions: fixture.exclusions, top: 100 });

/* ------------------------------------------------------------- aggregation */

test("several token accounts of one owner are summed into one holder", () => {
  const result = snapshot(base());
  const alice = result.holders.find((h) => h.owner === fixture.owners.alice);
  assert.ok(alice, "alice must be ranked");
  assert.equal(alice.balance, "4000");
  assert.equal(alice.accounts, 3);
});

test("a zero balance account never appears in the ranking", () => {
  const result = snapshot(base());
  const alice = result.holders.find((h) => h.owner === fixture.owners.alice);
  assert.equal(alice?.accounts, 3, "the empty fourth account is dropped, not counted");
});

test("excluded owners are dropped entirely", () => {
  const result = snapshot(base());
  const owners = result.holders.map((h) => h.owner);
  for (const exclusion of fixture.exclusions) {
    assert.ok(!owners.includes(exclusion.address), `${exclusion.kind} must be excluded`);
  }
});

test("the totals report how much was excluded", () => {
  const result = snapshot(base());
  assert.equal(result.totals.accounts, fixture.accounts.length);
  assert.equal(result.totals.accounts_excluded, 4);
  assert.equal(result.totals.owners, 5);
  assert.equal(result.totals.owners_excluded, 4);
});

test("the included balance is the sum of the kept balances", () => {
  const result = snapshot(base());
  assert.equal(result.totals.included_balance, String(4000 + 5000 + 9000 + 9000 + 30));
});

/* --------------------------------------------------------------- ranking */

test("holders are ranked by balance descending", () => {
  const result = snapshot(base());
  const balances = result.holders.map((h) => Number(h.balance));
  const sorted = [...balances].sort((a, b) => b - a);
  assert.deepEqual(balances, sorted);
});

test("a tie is broken by owner address ascending, not by input order", () => {
  const result = snapshot(base());
  const tied = result.holders.filter((h) => h.balance === "9000").map((h) => h.owner);
  assert.equal(tied.length, 2);
  assert.deepEqual(tied, [...tied].sort());
});

test("top limits the list without changing the totals", () => {
  const full = snapshot(base());
  const limited = snapshot({ ...base(), top: 2 });
  assert.equal(limited.holders.length, 2);
  assert.equal(limited.totals.included_balance, full.totals.included_balance);
  assert.deepEqual(limited.holders, full.holders.slice(0, 2));
});

/* ----------------------------------------------------------------- hashing */

test("the same input gives the same hash twice", () => {
  assert.equal(snapshot(base()).hash, snapshot(base()).hash);
});

test("a shuffled account list gives the same hash", () => {
  const shuffled = [...fixture.accounts].reverse();
  assert.equal(
    snapshot({ ...base(), accounts: shuffled }).hash,
    snapshot(base()).hash,
  );
});

test("the hash changes when one balance changes", () => {
  const accounts = fixture.accounts.map((a, i) => (i === 0 ? { ...a, amount: "9999" } : a));
  assert.notEqual(snapshot({ ...base(), accounts }).hash, snapshot(base()).hash);
});

test("the hash covers rank, owner and balance only", () => {
  const holders = snapshot(base()).holders;
  const expected = createHash("sha256")
    .update(JSON.stringify(holders.map((h) => [h.rank, h.owner, h.balance])))
    .digest("hex");
  assert.equal(hashHolders(holders), expected);
});

test("changing the supply changes shares but not the hash", () => {
  const plain = snapshot(base());
  const withSupply = snapshot({ ...base(), supply: "1000000" });
  assert.notEqual(plain.holders[0]?.share_pct, withSupply.holders[0]?.share_pct);
  assert.equal(plain.hash, withSupply.hash);
});

test("shares are computed against the included balance by default", () => {
  const result = snapshot(base());
  const top = result.holders[0] as { balance: string; share_pct: number };
  const expected = (Number(top.balance) / Number(result.totals.included_balance)) * 100;
  assert.ok(Math.abs(top.share_pct - expected) < 0.000001, `${top.share_pct} vs ${expected}`);
});

test("an explicit supply is used as the share base", () => {
  const result = snapshot({ ...base(), supply: "100000" });
  const top = result.holders[0] as { balance: string; share_pct: number };
  assert.equal(top.share_pct, Number(top.balance) / 1000);
});

/* --------------------------------------------------------------- refusals */

test("a supply smaller than the included balance is refused", () => {
  assert.throws(() => snapshot({ ...base(), supply: "1" }), SnapshotError);
});

test("top must be a positive integer", () => {
  assert.throws(() => snapshot({ ...base(), top: 0 }), /positive integer/);
  assert.throws(() => snapshot({ ...base(), top: 1.5 }), /positive integer/);
});

test("a negative amount is refused", () => {
  const accounts = [{ address: fixture.accounts[0]?.address as string, owner: fixture.owners.alice as string, amount: "-1" }];
  assert.throws(() => snapshot({ accounts, exclusions: [], top: 10 }), /non negative integer/);
});

test("a non integer amount is refused instead of being rounded", () => {
  const accounts = [{ address: fixture.accounts[0]?.address as string, owner: fixture.owners.alice as string, amount: "1.5" }];
  assert.throws(() => snapshot({ accounts, exclusions: [], top: 10 }), /non negative integer/);
});

test("an address that is not base58 is refused", () => {
  const accounts = [{ address: "not-base58-0OIl", owner: fixture.owners.alice as string, amount: "1" }];
  assert.throws(() => snapshot({ accounts, exclusions: [], top: 10 }), /base58/);
});

/* ------------------------------------------------------------ exclusions */

test("parseExclusions accepts a bare array", () => {
  const parsed = parseExclusions(fixture.exclusions);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0]?.kind, "curve");
});

test("parseExclusions accepts the wrapped object form", () => {
  const parsed = parseExclusions({ exclusions: fixture.exclusions });
  assert.equal(parsed.length, 4);
});

test("parseExclusions refuses an unknown kind", () => {
  assert.throws(() => parseExclusions([{ address: fixture.owners.alice, kind: "whale" }]), /unknown kind/);
});

test("parseExclusions refuses an entry with no address", () => {
  assert.throws(() => parseExclusions([{ kind: "pool" }]), /no address/);
});

/* --------------------------------------------------------- account decoding */

test("decodeTokenAccount reads the owner and the little endian amount", () => {
  const ownerBytes = createHash("sha256").update("owner-bytes").digest();
  const data = Buffer.alloc(72);
  ownerBytes.copy(data, 32);
  data.writeBigUInt64LE(123456789n, 64);
  const account = decodeTokenAccount("acct", data.toString("base64"));
  assert.equal(account.owner, encodeBase58(ownerBytes));
  assert.equal(account.amount, "123456789");
});

test("decodeTokenAccount refuses a short account", () => {
  assert.throws(() => decodeTokenAccount("acct", Buffer.alloc(40).toString("base64")), /shorter than 72 bytes/);
});

test("encodeBase58 keeps leading zeros as ones", () => {
  assert.equal(encodeBase58(Uint8Array.from([0, 0, 1])), "112");
  assert.equal(encodeBase58(Uint8Array.from([0])), "1");
});

/* ------------------------------------------------------------------- cli */

test("parseCli requires a mint and defaults top to 100", () => {
  const options = parseCli(["--mint", "So11111111111111111111111111111111111111112"]);
  assert.equal(options.top, 100);
  assert.equal(options.mint, "So11111111111111111111111111111111111111112");
});

test("parseCli refuses a missing mint", () => {
  assert.throws(() => parseCli([]), /--mint is required/);
});

test("parseCli refuses a bad top", () => {
  assert.throws(() => parseCli(["--mint", "x", "--top", "0"]), /positive integer/);
});

test("fetchAccounts decodes a stubbed rpc response", async () => {
  const ownerBytes = createHash("sha256").update("rpc-owner").digest();
  const data = Buffer.alloc(72);
  ownerBytes.copy(data, 32);
  data.writeBigUInt64LE(42n, 64);
  const stub = (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: [{ pubkey: "acct1", account: { data: [data.toString("base64"), "base64"] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const accounts = await fetchAccounts({
    rpcUrl: "https://rpc.invalid",
    mint: "So11111111111111111111111111111111111111112",
    fetchImpl: stub,
  });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.amount, "42");
  assert.equal(accounts[0]?.owner, encodeBase58(ownerBytes));
});

test("fetchAccounts surfaces an rpc error instead of returning an empty list", async () => {
  const stub = (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "node is behind" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    () => fetchAccounts({ rpcUrl: "https://rpc.invalid", mint: "x", fetchImpl: stub }),
    /node is behind/,
  );
});

test("fetchAccounts refuses a non 200 response", async () => {
  const stub = (async () => new Response("nope", { status: 503 })) as typeof fetch;
  await assert.rejects(
    () => fetchAccounts({ rpcUrl: "https://rpc.invalid", mint: "x", fetchImpl: stub }),
    /rpc returned 503/,
  );
});
