/**
 * Thin CLI: fetch the accounts over RPC, then hand them to the pure snapshot function.
 * The network lives here and nowhere else, so the core stays testable without a socket.
 */
import { readFile } from "node:fs/promises";
import { decodeTokenAccount, parseExclusions, snapshot, type TokenAccount } from "./snapshot.js";

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface RpcAccount {
  pubkey: string;
  account: { data: [string, string] };
}

export interface FetchOptions {
  rpcUrl: string;
  mint: string;
  programId?: string;
  slot?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Every token account for one mint. getProgramAccounts with a memcmp on the mint field and a
 * dataSlice of the owner and amount is enough: the snapshot only needs those 72 bytes.
 */
export async function fetchAccounts(options: FetchOptions): Promise<TokenAccount[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const config: Record<string, unknown> = {
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: options.mint } }],
  };
  if (options.slot !== undefined) config.slot = options.slot;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [options.programId ?? TOKEN_2022_PROGRAM, config],
  });

  const response = await doFetch(options.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error(`rpc returned ${response.status}`);
  const payload = (await response.json()) as {
    result?: RpcAccount[];
    error?: { message?: string };
  };
  if (payload.error) throw new Error(`rpc error: ${payload.error.message ?? "unknown"}`);
  const rows = payload.result ?? [];
  return rows.map((row) => decodeTokenAccount(row.pubkey, row.account.data[0]));
}

export interface CliOptions {
  mint: string;
  top: number;
  exclusionsPath?: string;
  rpcUrl: string;
  supply?: string;
  slot?: number;
  json: boolean;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(token.slice(2), "true");
    } else {
      flags.set(token.slice(2), next);
      i += 1;
    }
  }
  const mint = flags.get("mint");
  if (!mint) throw new Error("--mint is required");
  const topRaw = flags.get("top") ?? "100";
  const top = Number(topRaw);
  if (!Number.isInteger(top) || top <= 0) throw new Error("--top must be a positive integer");
  return {
    mint,
    top,
    rpcUrl: flags.get("rpc") ?? "https://api.mainnet-beta.solana.com",
    ...(flags.get("exclusions") ? { exclusionsPath: flags.get("exclusions") as string } : {}),
    ...(flags.get("supply") ? { supply: flags.get("supply") as string } : {}),
    ...(flags.get("slot") ? { slot: Number(flags.get("slot")) } : {}),
    json: flags.get("json") === "true",
  };
}

export async function run(options: CliOptions): Promise<string> {
  const accounts = await fetchAccounts({
    rpcUrl: options.rpcUrl,
    mint: options.mint,
    ...(options.slot === undefined ? {} : { slot: options.slot }),
  });
  const exclusions = options.exclusionsPath
    ? parseExclusions(JSON.parse(await readFile(options.exclusionsPath, "utf8")))
    : [];
  const result = snapshot({
    accounts,
    exclusions,
    top: options.top,
    ...(options.supply === undefined ? {} : { supply: options.supply }),
  });
  if (options.json) return JSON.stringify(result, null, 2);
  const lines = [
    `holders ${result.holders.length} of ${result.totals.owners} owners, ${result.totals.accounts} accounts`,
    `excluded ${result.totals.accounts_excluded} accounts`,
    `hash ${result.hash}`,
  ];
  for (const holder of result.holders) {
    lines.push(`${String(holder.rank).padStart(3)} ${holder.owner} ${holder.balance} ${holder.share_pct}%`);
  }
  return lines.join("\n");
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (invokedDirectly) {
  run(parseCli(process.argv.slice(2)))
    .then((output) => {
      console.log(output);
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
