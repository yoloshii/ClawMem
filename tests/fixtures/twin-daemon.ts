/**
 * BACKLOG 82.3, D7 — the vector daemon over a twin vault, in its OWN process, so its guard warnings can be counted.
 * Uses INDEX_PATH and XDG_RUNTIME_DIR from the environment; every query embeds near both twins. Prints READY on stdout
 * once the socket listens, then serves until killed.
 */
import { createStore } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { startVectorDaemon } from "../../src/vector-daemon.ts";
import { twinLlm } from "../helpers/twin-vault.ts";

setDefaultLlamaCpp(twinLlm);
const store = createStore(process.env.INDEX_PATH!);
const handle = await startVectorDaemon(store, m => process.stderr.write(`[daemon] ${m}\n`));
if (!handle) { process.stderr.write("[daemon] did not start\n"); process.exit(3); }
process.stdout.write("READY\n");
setInterval(() => {}, 1 << 30);
