import type { ChainConfig } from "./chains";

/**
 * Endpoint health checking.
 *
 * Public nodes go down often, and when they do the request usually still
 * succeeds at the HTTP level - a gateway answers with an HTML error page.
 * `response.json()` then fails with "Unexpected token '<'", which says nothing
 * about the real problem. Every endpoint is therefore probed before use, and
 * failures are reported in terms of the node rather than the parser.
 */

const PROBE_TIMEOUT_MS = 8_000;
const NODE_INFO_PATH = "/cosmos/base/tendermint/v1beta1/node_info";

export class NoHealthyEndpointError extends Error {
  readonly attempts: Array<{ url: string; reason: string }>;

  constructor(chainId: string, attempts: Array<{ url: string; reason: string }>) {
    const detail = attempts.map(({ url, reason }) => `  • ${url} — ${reason}`).join("\n");
    super(
      `Could not reach a working ${chainId} node.\n${detail}\n\n` +
        "Set a different endpoint in Settings and try again.",
    );
    this.name = "NoHealthyEndpointError";
    this.attempts = attempts;
  }
}

/** Fetch JSON, failing with a description of what came back instead. */
export async function fetchJson(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (caught) {
    if (caught instanceof Error && caught.name === "AbortError") {
      throw new Error(`no response within ${Math.round(timeoutMs / 1000)}s`);
    }
    // A CORS rejection is indistinguishable from a network failure here.
    throw new Error("unreachable (network error or CORS blocked)");
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();

  // Read the body rather than trusting the status: gateways return HTML with
  // a 200 as happily as with a 502.
  if (body.trimStart().startsWith("<")) {
    throw new Error(`returned an HTML page, not JSON (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("returned a response that is not valid JSON");
  }
}

async function probeChainId(lcdUrl: string): Promise<string> {
  const info = await fetchJson(`${lcdUrl}${NODE_INFO_PATH}`);
  const network = (info as { default_node_info?: { network?: string } })?.default_node_info
    ?.network;
  if (!network) throw new Error("did not report a chain id");
  return network;
}

/** Cached per chain, keyed by the candidate list so overrides invalidate it. */
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function candidates(chain: ChainConfig, override?: string): string[] {
  const parsed = (override ?? "")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : chain.lcdUrls;
}

/**
 * Return the first configured LCD that answers with JSON and reports this
 * chain's id. A single configured endpoint is still probed, so a dead node is
 * reported clearly instead of failing mid-query.
 */
export function resolveLcdUrl(chain: ChainConfig, override?: string): Promise<string> {
  const urls = candidates(chain, override);
  const key = `${chain.chainId}|${urls.join(",")}`;

  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const existing = pending.get(key);
  if (existing) return existing;

  const probe = (async () => {
    const attempts: Array<{ url: string; reason: string }> = [];

    for (const url of urls) {
      try {
        const chainId = await probeChainId(url);
        if (chainId !== chain.chainId) {
          attempts.push({ url, reason: `serves "${chainId}", not "${chain.chainId}"` });
          continue;
        }
        cache.set(key, url);
        pending.delete(key);
        return url;
      } catch (caught) {
        attempts.push({
          url,
          reason: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }

    pending.delete(key);
    throw new NoHealthyEndpointError(chain.chainId, attempts);
  })();

  pending.set(key, probe);
  return probe;
}

/** Forget cached endpoints so the next call probes again. */
export function resetResolvedEndpoints(): void {
  cache.clear();
  pending.clear();
}

/** Pick the RPC to hand Keplr. Not probed - Keplr checks it itself. */
export function rpcUrlFor(chain: ChainConfig, override?: string): string {
  const parsed = (override ?? "")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return parsed[0] ?? chain.rpcUrls[0];
}

/**
 * Rewrite low-level fetch/parse failures into something that names the actual
 * problem. secretjs calls `response.json()` directly, so a dead node surfaces
 * as a SyntaxError from deep inside the querier.
 */
export function describeNetworkError(caught: unknown): string {
  if (caught instanceof NoHealthyEndpointError) return caught.message;

  const message = caught instanceof Error ? caught.message : String(caught);

  if (caught instanceof SyntaxError || /Unexpected token|not valid JSON/i.test(message)) {
    return (
      "The node returned an HTML page instead of JSON, which usually means it is down or " +
      "behind an error gateway. Try again, or set a different endpoint in Settings."
    );
  }

  if (/Failed to fetch|NetworkError|load failed/i.test(message)) {
    return (
      "Could not reach the node. Check your connection, or set a different endpoint in " +
      "Settings."
    );
  }

  return message;
}
