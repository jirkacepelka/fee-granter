import { CHAIN_ID, LCD_URLS } from "./chain";

/**
 * Endpoint health checking.
 *
 * Public testnet nodes go down often, and when they do the request usually
 * still succeeds at the HTTP level - a gateway answers with an HTML error page.
 * `response.json()` then fails with "Unexpected token '<'", which says nothing
 * about the real problem. Every endpoint is therefore probed before use, and
 * failures are reported in terms of the node rather than the parser.
 */

const PROBE_TIMEOUT_MS = 8_000;
const NODE_INFO_PATH = "/cosmos/base/tendermint/v1beta1/node_info";

export class NoHealthyEndpointError extends Error {
  readonly attempts: Array<{ url: string; reason: string }>;

  constructor(attempts: Array<{ url: string; reason: string }>) {
    const detail = attempts.map(({ url, reason }) => `  • ${url} — ${reason}`).join("\n");
    super(
      `Could not reach a working ${CHAIN_ID} node.\n${detail}\n\n` +
        "Set NEXT_PUBLIC_SECRET_LCD_URL to a node you trust and reload.",
    );
    this.name = "NoHealthyEndpointError";
    this.attempts = attempts;
  }
}

/** Fetch JSON, failing with a description of what came back instead. */
async function fetchJson(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<unknown> {
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

/** The chain id an LCD reports, or throw describing why it could not be read. */
async function probeChainId(lcdUrl: string): Promise<string> {
  const info = await fetchJson(`${lcdUrl}${NODE_INFO_PATH}`);
  const network = (info as { default_node_info?: { network?: string } })?.default_node_info
    ?.network;
  if (!network) throw new Error("did not report a chain id");
  return network;
}

let resolved: string | undefined;
let inFlight: Promise<string> | undefined;

/**
 * Return the first configured LCD that answers with JSON and reports pulsar-3.
 * The result is cached for the session; a single configured endpoint is still
 * probed so a dead node is reported clearly instead of failing mid-query.
 */
export function resolveLcdUrl(): Promise<string> {
  if (resolved) return Promise.resolve(resolved);
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const attempts: Array<{ url: string; reason: string }> = [];

    for (const url of LCD_URLS) {
      try {
        const chainId = await probeChainId(url);
        if (chainId !== CHAIN_ID) {
          attempts.push({ url, reason: `serves "${chainId}", not "${CHAIN_ID}"` });
          continue;
        }
        resolved = url;
        return url;
      } catch (caught) {
        attempts.push({
          url,
          reason: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }

    inFlight = undefined;
    throw new NoHealthyEndpointError(attempts);
  })();

  return inFlight;
}

/** Forget the cached endpoint so the next call probes again. */
export function resetResolvedLcdUrl(): void {
  resolved = undefined;
  inFlight = undefined;
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
      `The ${CHAIN_ID} node returned an HTML page instead of JSON, which usually means ` +
      "it is down or behind an error gateway. Try again, or point " +
      "NEXT_PUBLIC_SECRET_LCD_URL at a different node."
    );
  }

  if (/Failed to fetch|NetworkError|load failed/i.test(message)) {
    return (
      `Could not reach the ${CHAIN_ID} node. Check your connection, or point ` +
      "NEXT_PUBLIC_SECRET_LCD_URL at a different node."
    );
  }

  return message;
}
