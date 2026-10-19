/**
 * Top holder snapshot for a Token 2022 mint.
 *
 * Pure core: accounts come in as data, the snapshot comes out as data. The RPC fetch lives
 * in cli.ts and is the only part that touches the network.
 *
 * Two properties the hash depends on, and both are enforced here rather than documented:
 *   - aggregation is exact (BigInt, never a float), so 10 + 20 always equals 30;
 *   - ordering is total (balance descending, then owner address ascending), so two runs on
 *     the same input cannot disagree about who is rank 7.
 */
import { createHash } from "node:crypto";

export interface TokenAccount {
  /** The token account address. */
  address: string;
  /** The wallet that owns the token account. */
  owner: string;
  /** Raw amount as a decimal string in base units, so nothing is lost. */
  amount: string;
}

export type ExclusionKind = "curve" | "pool" | "burn" | "project" | "custom";

export interface Exclusion {
  address: string;
  kind: ExclusionKind;
  label?: string;
}

export interface Holder {
  rank: number;
  owner: string;
  balance: string;
  share_pct: number;
  accounts: number;
}

export interface SnapshotInput {
  accounts: readonly TokenAccount[];
  exclusions: readonly Exclusion[];
  top: number;
  /** Optional: the supply to compute shares against. Defaults to the included total. */
  supply?: string;
}

export interface Snapshot {
  holders: Holder[];
  hash: string;
  /** Totals a reviewer needs to re-check the arithmetic. */
  totals: {
    accounts: number;
    accounts_excluded: number;
    owners: number;
    owners_excluded: number;
    included_balance: string;
    share_base: string;
  };
}

export class SnapshotError extends Error {}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function parseAmount(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new SnapshotError(`amount is not a non negative integer: ${value}`);
  return BigInt(value);
}

function normalise(address: string): string {
  if (!ADDRESS.test(address)) throw new SnapshotError(`not a base58 address: ${address}`);
  return address;
}

/** Percent with six decimals, computed in integer space so it never drifts. */
function sharePct(balance: bigint, base: bigint): number {
  if (base === 0n) return 0;
  const scaled = (balance * 100_000_000n) / base;
  return Number(scaled) / 1_000_000;
}

export function snapshot(input: SnapshotInput): Snapshot {
  const { accounts, exclusions, top } = input;
  if (!Number.isInteger(top) || top <= 0) throw new SnapshotError("top must be a positive integer");

  const excluded = new Map<string, Exclusion>();
  for (const exclusion of exclusions) {
    excluded.set(normalise(exclusion.address), exclusion);
  }

  const byOwner = new Map<string, { balance: bigint; accounts: number }>();
  let accountsExcluded = 0;
  for (const account of accounts) {
    const owner = normalise(account.owner);
    normalise(account.address);
    const amount = parseAmount(account.amount);
    if (excluded.has(owner)) {
      accountsExcluded += 1;
      continue;
    }
    // A token account holding nothing is not a holder and is not counted as one.
    if (amount === 0n) continue;
    const current = byOwner.get(owner);
    if (current) {
      current.balance += amount;
      current.accounts += 1;
    } else {
      byOwner.set(owner, { balance: amount, accounts: 1 });
    }
  }

  const ranked = [...byOwner.entries()]
    .filter(([, value]) => value.balance > 0n)
    .sort((a, b) => {
      if (a[1].balance !== b[1].balance) return a[1].balance > b[1].balance ? -1 : 1;
      // Total order: the address decides, so ties never depend on input order.
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  const includedBalance = ranked.reduce((sum, [, value]) => sum + value.balance, 0n);
  const shareBase = input.supply === undefined ? includedBalance : parseAmount(input.supply);
  if (shareBase < includedBalance) {
    throw new SnapshotError("supply is smaller than the included balance");
  }

  const holders: Holder[] = ranked.slice(0, top).map(([owner, value], index) => ({
    rank: index + 1,
    owner,
    balance: value.balance.toString(),
    share_pct: sharePct(value.balance, shareBase),
    accounts: value.accounts,
  }));

  return {
    holders,
    hash: hashHolders(holders),
    totals: {
      accounts: accounts.length,
      accounts_excluded: accountsExcluded,
      owners: byOwner.size,
      owners_excluded: excluded.size,
      included_balance: includedBalance.toString(),
      share_base: shareBase.toString(),
    },
  };
}

/**
 * The hash covers rank, owner and balance only. Shares are derived, so including them would
 * make the hash change when only the supply argument changed.
 */
export function hashHolders(holders: readonly Holder[]): string {
  const canonical = JSON.stringify(
    holders.map((holder) => [holder.rank, holder.owner, holder.balance]),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** Decode the amount and owner out of a Token 2022 account's base64 data. */
export function decodeTokenAccount(address: string, base64: string): TokenAccount {
  const data = Buffer.from(base64, "base64");
  if (data.length < 72) throw new SnapshotError(`account ${address} is shorter than 72 bytes`);
  const owner = encodeBase58(data.subarray(32, 64));
  const amount = data.readBigUInt64LE(64);
  return { address, owner, amount: amount.toString() };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] as number) * 256;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += ALPHABET[0];
  }
  while (digits.length > 1 && digits[digits.length - 1] === 0) digits.pop();
  const value = digits.length === 1 && digits[0] === 0 ? [] : digits;
  for (let i = value.length - 1; i >= 0; i -= 1) out += ALPHABET[value[i] as number];
  return out;
}

/** Parse an exclusions file. Accepts either a bare array or { exclusions: [...] }. */
export function parseExclusions(raw: unknown): Exclusion[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { exclusions?: unknown }).exclusions)
      ? ((raw as { exclusions: unknown[] }).exclusions)
      : null;
  if (!list) throw new SnapshotError("exclusions must be an array or { exclusions: [...] }");
  const kinds: ExclusionKind[] = ["curve", "pool", "burn", "project", "custom"];
  return list.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new SnapshotError(`exclusion ${index} is not an object`);
    const record = entry as Partial<Exclusion>;
    if (typeof record.address !== "string") throw new SnapshotError(`exclusion ${index} has no address`);
    if (typeof record.kind !== "string" || !kinds.includes(record.kind as ExclusionKind)) {
      throw new SnapshotError(`exclusion ${index} has an unknown kind`);
    }
    return {
      address: record.address,
      kind: record.kind as ExclusionKind,
      ...(record.label === undefined ? {} : { label: record.label }),
    };
  });
}
