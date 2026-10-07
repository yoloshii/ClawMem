/**
 * Endpoint URL normalization for CLAWMEM_EMBED_URL / CLAWMEM_RERANK_URL.
 *
 * ClawMem appends its own paths to these roots (`/v1/embeddings`, `/v1/rerank`).
 * Operators routinely paste the full endpoint instead (`http://localhost:11434/v1/embeddings`,
 * `https://api.jina.ai/v1`), which produced `/v1/embeddings/v1/embeddings` — every request 404'd,
 * indexing kept reporting success, and documents silently stayed unembedded. The LLM URL already
 * accepts a root, `…/v1` or a full `…/chat/completions` (`buildRemoteChatCompletionsUrl`); this
 * gives the embedding and rerank URLs the same tolerance.
 */

const ENDPOINT_SUFFIXES: Record<string, readonly string[]> = {
  CLAWMEM_EMBED_URL: ["/v1/embeddings", "/v1"],
  CLAWMEM_RERANK_URL: ["/v1/rerank", "/v1"],
};

/** Strip trailing slashes and any of `suffixes` (repeatedly) so the result is the server root. */
export function normalizeEndpointRoot(url: string, suffixes: readonly string[]): string {
  let u = url.trim().replace(/\/+$/, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of suffixes) {
      if (u.toLowerCase().endsWith(s)) {
        u = u.slice(0, -s.length).replace(/\/+$/, "");
        changed = true;
      }
    }
  }
  return u;
}

/** Notes describing rewrites made by the last `normalizeEndpointEnv` call (surfaced by `clawmem doctor`). */
export const endpointEnvNotes: string[] = [];

/**
 * Rewrite the endpoint env vars in place to their server roots. Idempotent; returns the notes.
 * Called once at CLI start, before any module reads the variables.
 */
export function normalizeEndpointEnv(env: Record<string, string | undefined> = process.env): string[] {
  endpointEnvNotes.length = 0;
  for (const [key, suffixes] of Object.entries(ENDPOINT_SUFFIXES)) {
    const value = env[key];
    if (!value || !value.trim()) continue;
    const root = normalizeEndpointRoot(value, suffixes);
    if (root !== value) {
      env[key] = root;
      endpointEnvNotes.push(`${key}="${value}" was read as "${root}" (ClawMem appends ${suffixes[0]} itself)`);
    }
  }
  return [...endpointEnvNotes];
}
