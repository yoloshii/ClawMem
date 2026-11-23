/**
 * BACKLOG 82.3, D7 — one worker phase over a twin vault, in its OWN process (its guard warnings are counted). The
 * model is a fake that answers the cluster prompt with one observation over both listed sources and "[]" otherwise.
 * usage: bun tests/fixtures/twin-worker.ts heavy|consolidate|stop-tick   (INDEX_PATH from the environment)
 * Prints one JSON line: { ok, error }.
 */
import { createStore } from "../../src/store.ts";
import { runHeavyMaintenanceTick } from "../../src/maintenance.ts";
import { consolidateObservations } from "../../src/consolidation.ts";
import { runStopWorkerTick } from "../../src/stop-worker.ts";
import { fakeBudgetLlm } from "../helpers/fake-budget-llm.ts";

const phase = process.argv[2];
const llm = fakeBudgetLlm({
  nCtx: 8192,
  reply: (p: string) => (p.includes("identify recurring patterns")
    ? JSON.stringify([{ observation: "The tank filter is cleaned on a schedule", proof_count: 2, source_indices: [1, 2] }])
    : "[]"),
}).llm as any;
const store = createStore(process.env.INDEX_PATH!);
let out: { ok: boolean; error: string | null } = { ok: true, error: null };
try {
  if (phase === "heavy") await runHeavyMaintenanceTick(store, llm, { windowStartHour: null, windowEndHour: null, workerName: "twin-heavy" });
  else if (phase === "consolidate") await consolidateObservations(store, llm);
  else if (phase === "stop-tick") await runStopWorkerTick(store, [], llm);
  else throw new Error(`unknown phase ${phase}`);
} catch (e) {
  out = { ok: false, error: `${(e as Error)?.name}: ${String((e as Error)?.message).slice(0, 200)}` };
}
store.close();
process.stdout.write(JSON.stringify(out) + "\n");
