/**
 * BACKLOG 82.2, D4 — the vector leg of the CLI search commands (`clawmem vsearch`, `clawmem query`), and what the
 * command says about it.
 *
 * A leg has three outcomes the command must tell apart:
 *  - it answered: the results stand; stored vectors the scan skipped as unusable are counted;
 *  - its QUERY vector was refused (the embedding endpoint answered with a malformed vector): no vector results —
 *    `vsearch` stops with an explicit error, `query` goes on with its lexical results and says so;
 *  - anything else (the endpoint is down, a dimension or model error): thrown, as before this change.
 */
import { DEFAULT_EMBED_MODEL, type SearchResult, type Store } from "./store.ts";
import { isRefusedEmbedResponse } from "./vector-guard.ts";

/** The message of the explicit error (`vsearch`), and the reason given in a warning (`query`). */
export const VECTOR_SEARCH_UNAVAILABLE = "vector search unavailable: the embedding endpoint returned a malformed vector";

export interface CliVectorLeg {
  results: SearchResult[];
  /** The query vector of this leg was refused: the leg has no results. */
  refused: boolean;
  /** Stored vectors the scan skipped as unusable. */
  vectorFaults: number;
}

export async function cliVectorLeg(store: Pick<Store, "searchVecWithFaults">, query: string, limit: number): Promise<CliVectorLeg> {
  try {
    const found = await store.searchVecWithFaults(query, DEFAULT_EMBED_MODEL, limit);
    return { results: found.results, refused: false, vectorFaults: found.vectorFaults };
  } catch (e) {
    if (isRefusedEmbedResponse(e)) return { results: [], refused: true, vectorFaults: 0 };
    throw e;
  }
}

export interface CliVectorReport {
  /** The fields a `--json` reply gains when something was degraded (operator ruling 25 A); undefined when nothing was. */
  degraded?: { degraded: true; degradedReason: "vector-fault"; vectorFaults?: number };
  /**
   * The ONE line for stderr about refused query vectors; undefined when none was refused. Stored vectors that
   * are not usable have their own line already: the scan writes it once per process (`screenVecHits`).
   */
  warning?: string;
}

/**
 * What a command reports for its vector legs. The legs of one command scan the same stored vectors, so the count
 * of unusable ones is the largest any leg met, not their sum.
 */
export function cliVectorReport(legs: CliVectorLeg[]): CliVectorReport {
  const refused = legs.filter(leg => leg.refused).length;
  const faults = legs.reduce((most, leg) => Math.max(most, leg.vectorFaults), 0);
  if (refused === 0 && faults === 0) return {};
  const warning = refused === 0 ? undefined
    : `Warning: ${VECTOR_SEARCH_UNAVAILABLE} (${refused} of ${legs.length} vector ${legs.length === 1 ? "leg" : "legs"}); ` +
      `${refused === legs.length ? "the results are lexical only" : "the other legs answered"}.`;
  return {
    degraded: { degraded: true, degradedReason: "vector-fault", ...(faults > 0 ? { vectorFaults: faults } : {}) },
    ...(warning ? { warning } : {}),
  };
}
