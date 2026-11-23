/**
 * Stub the in-process vector search of a store for a test (v0.43.7, BACKLOG 82.2 D4, operator ruling 16 B).
 * Source routes call `searchVecWithFaults`; a test that controls the vector leg gives the LIST it wants returned,
 * and this installs it on both forms — the list form as it is, the fault-carrying form with a count of zero.
 */
import type { SearchResult, Store } from "../../src/store.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListSearch = (...args: any[]) => Promise<SearchResult[]>;

export function stubSearchVec(store: object, search: ListSearch): void {
  const target = store as { searchVec: ListSearch; searchVecWithFaults: Store["searchVecWithFaults"] };
  target.searchVec = search;
  target.searchVecWithFaults = (async (...args: unknown[]) => ({ results: await search(...args), vectorFaults: 0 })) as Store["searchVecWithFaults"];
}

/** Put a store's own two searches back (for a test that stubbed them inside a try). */
export function realSearches(store: Store): () => void {
  const { searchVec, searchVecWithFaults } = store;
  return () => { store.searchVec = searchVec; store.searchVecWithFaults = searchVecWithFaults; };
}
