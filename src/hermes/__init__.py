"""ClawMem memory provider plugin for Hermes Agent.

On-device hybrid memory with composite scoring, graph traversal, and
lifecycle management. Integrates via REST API (tools) and CLI shell-out
(lifecycle hooks).

Requires:
  - clawmem binary on PATH (or configured via CLAWMEM_BIN)
  - clawmem serve running (or managed mode starts it automatically)

Config via environment variables:
  CLAWMEM_BIN           — Path to clawmem binary (default: auto-detect on PATH)
  CLAWMEM_SERVE_PORT    — REST API port (default: 7438)
  CLAWMEM_SERVE_MODE    — "external" (default) or "managed" (plugin starts/stops serve)
  CLAWMEM_PROFILE       — Retrieval profile: speed, balanced, deep (default: balanced)
  CLAWMEM_EMBED_URL     — GPU embedding server URL (optional)
  CLAWMEM_LLM_URL       — GPU LLM server URL (optional)
  CLAWMEM_LLM_MODEL     — Model name sent to the GPU/cloud LLM endpoint (optional)
  CLAWMEM_LLM_REASONING_EFFORT — Top-level reasoning_effort for supporting Chat Completions endpoints (optional)
  CLAWMEM_LLM_NO_THINK  — Append /no_think to remote prompts; false disables it for standard OpenAI models (optional)
  CLAWMEM_RERANK_URL    — GPU reranker server URL (optional)

Agent-context isolation:
  Hermes ``run_agent.py`` passes ``agent_context`` to ``initialize()``
  with one of "primary", "subagent", "cron", or "flush". Per the
  ``MemoryProvider`` ABC contract ("Providers should skip writes for
  non-primary contexts (cron system prompts would corrupt user
  representations)"), this plugin treats the read-side hooks
  (session-bootstrap, context-surfacing) as always safe but routes the
  write-side surfaces (transcript appends in ``sync_turn``, extraction
  in ``on_session_end`` and ``on_pre_compress``) through a primary-only
  guard. Non-primary contexts get retrieval but no vault writes.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import fcntl  # POSIX: one append at a time with another process writing the same transcript
except ImportError:  # Windows: this process's own lock still serializes its writes
    fcntl = None  # type: ignore[assignment]

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_DEFAULT_PORT = 7438
_HOOK_TIMEOUT = 30  # seconds
_REST_TIMEOUT = 5.0  # seconds
_SESSION_END_TIMEOUT = 5  # seconds: the render-only SessionEnd flush stops itself after 1 s
# The host every hook input names: ClawMem credits a Hermes prefetch in the turn that received it.
_HOST = "hermes"
# A hand-over is recorded only when prefetch() returned within this bound. Hermes gives an external provider 8 s by
# default (agent/memory_manager.py _EXTERNAL_PREFETCH_TIMEOUT_S) and discards a later result, so a call that took longer
# may never have reached the agent: it is recorded as no delivery rather than claimed.
_DELIVERY_ACK_S = 6.0
# Turns started but not yet synced, per text, that the plugin keeps notes for; past it the oldest note is closed as
# unresolved (a sync backlog this deep is not expected).
_PENDING_DELIVERIES_MAX = 256
_OUTCOME_TYPE = "clawmem-prefetch-outcome"
# Writes kept per transcript while it cannot be written (a turn's, or an outcome record's, each) and their bytes; past
# either, the oldest not yet begun is given up with a warning. A transcript whose write failed is tried again after a
# pause that doubles from _RETRY_MIN_S to _RETRY_MAX_S, and at once at a session's end, a switch and shutdown.
_OUTBOX_MAX = 256
_OUTBOX_MAX_BYTES = 16 * 1024 * 1024
_RETRY_MIN_S = 0.5
_RETRY_MAX_S = 30.0
# Names tried for a session's transcript while other processes hold them (`<id>.jsonl`, `<id>.2.jsonl`, …).
_CLAIM_TRIES = 8
_STOP_HOOKS = ("decision-extractor", "handoff-generator", "feedback-loop")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_clawmem_bin() -> Optional[str]:
    """Find the clawmem binary. Check env, then PATH."""
    env_bin = os.environ.get("CLAWMEM_BIN")
    if env_bin and os.path.isfile(env_bin) and os.access(env_bin, os.X_OK):
        return env_bin
    return shutil.which("clawmem")


def _run_hook(bin_path: str, hook_name: str, hook_input: dict,
              timeout: int = _HOOK_TIMEOUT, env_extra: Optional[dict] = None) -> Optional[str]:
    """Shell out to clawmem hook <name>. Returns stdout or None on failure."""
    try:
        env = {**os.environ, **(env_extra or {})}
        result = subprocess.run(
            [bin_path, "hook", hook_name],
            input=json.dumps(hook_input),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        if result.returncode == 0:
            return result.stdout
        logger.debug("clawmem hook %s exited %d: %s", hook_name, result.returncode, result.stderr)
        return None
    except subprocess.TimeoutExpired:
        logger.debug("clawmem hook %s timed out after %ds", hook_name, timeout)
        return None
    except Exception as e:
        logger.debug("clawmem hook %s failed: %s", hook_name, e)
        return None


def _rest_call(port: int, method: str, path: str,
               body: Optional[dict] = None, timeout: float = _REST_TIMEOUT) -> Optional[dict]:
    """Call the ClawMem REST API. Returns parsed JSON or None."""
    headers: dict = {"Content-Type": "application/json"}
    token = os.environ.get("CLAWMEM_API_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        import httpx
    except ImportError:
        # Fallback to urllib for zero-dependency operation
        import urllib.request
        import urllib.error
        url = f"http://127.0.0.1:{port}{path}"
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode() if body else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.URLError, Exception) as e:
            logger.debug("ClawMem REST %s %s failed: %s", method, path, e)
            return None

    try:
        client = httpx.Client(timeout=timeout)
        if method == "GET":
            resp = client.get(f"http://127.0.0.1:{port}{path}", headers=headers)
        else:
            resp = client.post(
                f"http://127.0.0.1:{port}{path}",
                json=body or {},
                headers=headers,
            )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.debug("ClawMem REST %s %s failed: %s", method, path, e)
        return None


def _extract_context(hook_output: str) -> str:
    """Extract additionalContext from hook JSON output."""
    if not hook_output:
        return ""
    try:
        parsed = json.loads(hook_output.strip().split("\n")[-1])
        hso = parsed.get("hookSpecificOutput", {})
        return hso.get("additionalContext", "")
    except (json.JSONDecodeError, IndexError):
        return ""


def _extract_usage_id(hook_output: str) -> Optional[int]:
    """The id of the context-surfacing row that produced this context (sent to the Hermes host only)."""
    try:
        value = json.loads(hook_output.strip().split("\n")[-1]).get("clawmemUsageId")
    except (json.JSONDecodeError, IndexError, AttributeError):
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _norm_turn_text(text: str) -> str:
    """The key that matches a turn's prefetch query with the user text synced for it: NFC, whitespace collapsed."""
    return " ".join(unicodedata.normalize("NFC", text or "").split())


def _iso_ms(epoch_ms: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch_ms // 1000)) + ".%03dZ" % (epoch_ms % 1000)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _first_stamp(group: bytes) -> str:
    """The timestamp on a group's first line, "" when it has none. Every stamp comes from `_iso_ms`, whose fixed-width
    form orders as text."""
    try:
        stamp = json.loads(group[:group.index(b"\n")]).get("timestamp")
    except (ValueError, AttributeError):
        return ""
    return stamp if isinstance(stamp, str) else ""


def _write_all(fd: int, data) -> tuple:
    """Write all of `data`, however many calls it takes. Returns (bytes written, whether that was all of it); a call
    that fails writes nothing, so the count is exactly what of `data` is on disk."""
    view = memoryview(data)
    done = 0
    while done < len(view):
        try:
            n = os.write(fd, view[done:])
        except InterruptedError:
            continue
        except OSError as e:
            logger.debug("clawmem: transcript write failed: %s", e)
            return done, False
        if n <= 0:
            return done, False
        done += n
    return done, True


def _try_lock(fd: int) -> Optional[bool]:
    """Lock a transcript for this process without waiting: True; False while another process holds it; None where the
    platform or the file system cannot lock."""
    if fcntl is None:
        return None
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except InterruptedError:
            continue
        except BlockingIOError:
            return False
        except OSError:
            return None


def _names_file(fd: int, path: str) -> bool:
    """`path` still names the file `fd` has open (a transcript moved or replaced no longer does)."""
    try:
        held, named = os.fstat(fd), os.stat(path)
    except OSError:
        return False
    return (held.st_dev, held.st_ino) == (named.st_dev, named.st_ino)


def _last_byte(fd: int, size: int) -> bytes:
    if hasattr(os, "pread"):
        return os.pread(fd, 1, size - 1)
    os.lseek(fd, size - 1, os.SEEK_SET)
    return os.read(fd, 1)


def _new_box() -> Dict[str, Any]:
    """A transcript's waiting writes: groups of complete lines, oldest first, `done` bytes of the first already on disk
    (the file then ending at `end`); the session whose turns they carry; when to try again, and the pause before it."""
    return {"groups": [], "bytes": 0, "sid": "", "done": 0, "end": -1, "next_try": 0.0, "pause": 0.0}


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

RETRIEVE_SCHEMA = {
    "name": "clawmem_retrieve",
    "description": (
        "Search long-term memory with auto-routing. Handles keyword, semantic, "
        "causal, and timeline queries automatically. Use for recalling past "
        "decisions, preferences, session history, and learned patterns."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query."},
            "limit": {"type": "integer", "description": "Max results (default: 10)."},
        },
        "required": ["query"],
    },
}

GET_SCHEMA = {
    "name": "clawmem_get",
    "description": (
        "Retrieve full content of a memory document by its docid (6-char hex prefix)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "docid": {"type": "string", "description": "Document ID (6-char hex prefix)."},
        },
        "required": ["docid"],
    },
}

SESSION_LOG_SCHEMA = {
    "name": "clawmem_session_log",
    "description": "List recent session summaries for cross-session context.",
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "Number of sessions (default: 5)."},
        },
    },
}

TIMELINE_SCHEMA = {
    "name": "clawmem_timeline",
    "description": "Show temporal context around a document — what was created before and after.",
    "parameters": {
        "type": "object",
        "properties": {
            "docid": {"type": "string", "description": "Document ID (6-char hex prefix)."},
            "before": {"type": "integer", "description": "Docs before (default: 5)."},
            "after": {"type": "integer", "description": "Docs after (default: 5)."},
        },
        "required": ["docid"],
    },
}

SIMILAR_SCHEMA = {
    "name": "clawmem_similar",
    "description": "Find documents semantically similar to a given document.",
    "parameters": {
        "type": "object",
        "properties": {
            "docid": {"type": "string", "description": "Document ID (6-char hex prefix)."},
            "limit": {"type": "integer", "description": "Max results (default: 5)."},
        },
        "required": ["docid"],
    },
}


# ---------------------------------------------------------------------------
# MemoryProvider implementation
# ---------------------------------------------------------------------------

class ClawMemProvider(MemoryProvider):
    """ClawMem memory provider for Hermes Agent."""

    def __init__(self):
        self._bin: Optional[str] = None
        self._port: int = _DEFAULT_PORT
        self._session_id: str = ""
        self._transcript_path: str = ""
        self._hermes_home: str = ""
        self._serve_mode: str = "external"
        self._serve_proc: Optional[subprocess.Popen] = None
        self._env_extra: dict = {}
        # Agent-context isolation. "primary" = full read+write; everything else
        # ("subagent", "cron", "flush") = reads OK, writes suppressed. See file
        # docstring for the ABC contract this implements.
        self._agent_context: str = "primary"

        # Prefetch state (generation counter prevents stale overwrites)
        self._prefetch_result: str = ""
        self._prefetch_result_gen: int = 0  # generation of stored result
        self._prefetch_generation: int = 0  # latest queued generation
        self._prefetch_consumed_gen: int = 0  # last generation consumed by prefetch()
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._prefetch_result_usage_id: Optional[int] = None  # the surfacing row the stored result came from
        self._prefetch_result_path: str = ""                   # and that row's transcript
        # Turns not yet synced, per normalized text: {"started": turns begun (on_turn_start), "noted": prefetch()
        # calls, "uid": id|None, "path": str, "ambiguous": bool}. See _note_delivery.
        self._pending_deliveries: Dict[str, Dict[str, Any]] = {}

        # Transcript writes are serialized, and stamped with millisecond wall-clock times under the same lock, so a
        # transcript's times follow its order in the file unless the clock is set back (`_append_transcript`). A write
        # that fails waits here, per transcript and in order, until it can be written (`_new_box`, `_write_box`).
        self._transcript_lock = threading.Lock()
        self._outbox: Dict[str, Dict[str, Any]] = {}
        # The transcripts this process writes, held open (and locked) while it writes them (`_claim`), and those it
        # named for itself where nothing can be locked.
        self._claims: Dict[str, int] = {}
        self._own: set = set()
        # Prefetches running per transcript: a transcript is held until those that may still record an outcome for it
        # have finished (T34 #4).
        self._inflight: Dict[str, int] = {}

        # Bootstrap context (consumed on first prefetch)
        self._bootstrap_context: str = ""

        # Stop passes (decision-extractor, handoff-generator, feedback-loop) run one at a time on a background
        # thread; requests made while one runs wait in order, one per transcript.
        self._stop_lock = threading.Lock()
        self._stop_cond = threading.Condition(self._stop_lock)
        self._stop_pending: Dict[tuple, None] = {}
        self._stop_thread: Optional[threading.Thread] = None
        self._stop_running: Optional[tuple] = None  # the (session id, transcript path) whose pass is running

    @property
    def name(self) -> str:
        return "clawmem"

    # -- Config ----------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "serve_port",
                "description": "ClawMem REST API port",
                "default": str(_DEFAULT_PORT),
                "env_var": "CLAWMEM_SERVE_PORT",
            },
            {
                "key": "serve_mode",
                "description": "Server mode: 'external' (you run clawmem serve) or 'managed' (plugin manages it)",
                "default": "external",
                "choices": ["external", "managed"],
                "env_var": "CLAWMEM_SERVE_MODE",
            },
            {
                "key": "profile",
                "description": "Retrieval profile: speed (BM25 only), balanced (hybrid), deep (full pipeline)",
                "default": "balanced",
                "choices": ["speed", "balanced", "deep"],
                "env_var": "CLAWMEM_PROFILE",
            },
            {
                "key": "bin_path",
                "description": "Path to clawmem binary (auto-detected if on PATH)",
                "env_var": "CLAWMEM_BIN",
            },
            {
                "key": "embed_url",
                "description": "GPU embedding server URL (e.g., http://localhost:8088)",
                "secret": False,
                "env_var": "CLAWMEM_EMBED_URL",
            },
            {
                "key": "llm_url",
                "description": "GPU LLM server URL (e.g., http://localhost:8089)",
                "secret": False,
                "env_var": "CLAWMEM_LLM_URL",
            },
            {
                "key": "llm_model",
                "description": "Model name sent to the GPU LLM server (e.g., qwen3, gpt-5.4-mini)",
                "secret": False,
                "env_var": "CLAWMEM_LLM_MODEL",
            },
            {
                "key": "llm_reasoning_effort",
                "description": "Optional top-level reasoning_effort for Chat Completions endpoints that support it",
                "secret": False,
                "env_var": "CLAWMEM_LLM_REASONING_EFFORT",
            },
            {
                "key": "llm_no_think",
                "description": "Append /no_think to remote LLM prompts; disable for standard OpenAI models",
                "secret": False,
                "env_var": "CLAWMEM_LLM_NO_THINK",
            },
        ]

    # -- Core lifecycle --------------------------------------------------------

    def is_available(self) -> bool:
        """Check if clawmem binary is on PATH. No network calls."""
        return _find_clawmem_bin() is not None

    def initialize(self, session_id: str, **kwargs) -> None:
        self._bin = _find_clawmem_bin()
        if not self._bin:
            logger.warning("clawmem binary not found on PATH — provider disabled")
            return

        self._session_id = session_id
        try:
            self._port = int(os.environ.get("CLAWMEM_SERVE_PORT", _DEFAULT_PORT))
        except (ValueError, TypeError):
            self._port = _DEFAULT_PORT
        self._serve_mode = os.environ.get("CLAWMEM_SERVE_MODE", "external")
        self._hermes_home = kwargs.get("hermes_home", str(Path.home() / ".hermes"))
        self._agent_context = str(kwargs.get("agent_context", "primary") or "primary")
        if self._agent_context != "primary":
            logger.info(
                "clawmem: agent_context=%s — reads enabled, writes suppressed",
                self._agent_context,
            )

        # Build env for hook shell-outs (GPU endpoints, profile)
        for var in (
            "CLAWMEM_EMBED_URL",
            "CLAWMEM_LLM_URL",
            "CLAWMEM_LLM_MODEL",
            "CLAWMEM_LLM_REASONING_EFFORT",
            "CLAWMEM_LLM_NO_THINK",
            "CLAWMEM_RERANK_URL",
            "CLAWMEM_PROFILE",
        ):
            val = os.environ.get(var)
            if val:
                self._env_extra[var] = val

        # Create transcript directory; a primary context claims the transcript it writes (`_claim`)
        transcript_dir = Path(self._hermes_home) / "clawmem-transcripts"
        transcript_dir.mkdir(parents=True, exist_ok=True)
        self._transcript_path = (self._claim(session_id) if self._agent_context == "primary"
                                 else str(transcript_dir / f"{session_id}.jsonl"))

        # Start managed serve if configured
        if self._serve_mode == "managed":
            self._start_serve()

        # Run session-bootstrap hook
        hook_input = {
            "session_id": session_id,
            "transcript_path": self._transcript_path,
            "hook_event_name": "SessionStart",
            "host": _HOST,
        }
        output = _run_hook(self._bin, "session-bootstrap", hook_input, env_extra=self._env_extra)
        if output:
            ctx = _extract_context(output)
            if ctx:
                self._bootstrap_context = ctx
                logger.info("clawmem: session-bootstrap returned %d chars of context", len(ctx))

    def system_prompt_block(self) -> str:
        if not self._bin:
            return ""
        return (
            "# ClawMem Memory System\n"
            "Active. Use clawmem_retrieve to search memory, clawmem_get for "
            "full documents, clawmem_session_log for session history, "
            "clawmem_timeline for temporal context, clawmem_similar for discovery."
        )

    # -- Prefetch / recall -----------------------------------------------------

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        """Count the turn under its text: Hermes calls this for every turn, trivial ones included, before prefetch."""
        if self._agent_context != "primary":
            return
        unresolved: List[tuple] = []
        with self._prefetch_lock:
            st = self._key_state(_norm_turn_text(message))
            st["started"] += 1
            unresolved = self._settle_ambiguity(st)
        for uid, path in unresolved:
            self._record_outcome(path, uid, "unresolved")

    def _key_state(self, key: str) -> Dict[str, Any]:
        """The pending state of a text (created if absent), moved to the most-recent end. Call under _prefetch_lock."""
        st = self._pending_deliveries.pop(key, None) or {"started": 0, "noted": 0, "uid": None, "path": "", "ambiguous": False}
        self._pending_deliveries[key] = st
        return st

    @staticmethod
    def _settle_ambiguity(st: Dict[str, Any]) -> List[tuple]:
        """More than one unsynced turn of one text: which sync is whose cannot be proved. Returns the ids to close."""
        if max(st["started"], st["noted"]) <= 1 and not st["ambiguous"]:
            return []
        st["ambiguous"] = True
        out = [(st["uid"], st["path"])] if st["uid"] is not None else []
        st["uid"], st["path"] = None, ""
        return out

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return cached prefetch result + any unconsumed bootstrap context.

        Also settles, for ClawMem's feedback step, what became of the cached prefetch: handed to this turn (its row's
        id is written on this turn's user line by the turn's sync, `_note_delivery`), or dropped (an explicit record,
        `_record_outcome`). ClawMem credits a row's documents only in the turn that received it.
        """
        t0 = time.monotonic()
        # Wait for background thread if still running
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=3.0)

        parts = []

        # Consume bootstrap context (one-shot, first turn only)
        if self._bootstrap_context:
            parts.append(self._bootstrap_context)
            self._bootstrap_context = ""

        # Consume prefetched context only if it's from a generation we haven't consumed yet
        delivered: Optional[tuple] = None
        dropped: List[tuple] = []
        with self._prefetch_lock:
            if (self._prefetch_result
                    and self._prefetch_result_gen > self._prefetch_consumed_gen):
                parts.append(self._prefetch_result)
                if self._prefetch_result_usage_id is not None:
                    delivered = (self._prefetch_result_usage_id, self._prefetch_result_path)
            elif self._prefetch_result_usage_id is not None:
                dropped.append((self._prefetch_result_usage_id, self._prefetch_result_path))
            # Always advance consumed_gen to current queued generation — this
            # prevents late-arriving results from leaking into the next turn
            self._prefetch_consumed_gen = self._prefetch_generation
            self._prefetch_result = ""
            self._prefetch_result_usage_id = None
            self._prefetch_result_path = ""
        for uid, path in dropped:
            self._record_outcome(path, uid, "dropped")
        if delivered is not None and time.monotonic() - t0 > _DELIVERY_ACK_S:
            # The host may have given up on this call and discarded the context: never claim the hand-over.
            self._record_outcome(delivered[1], delivered[0], "unresolved")
            delivered = None
        self._note_delivery(query, delivered)

        return "\n\n".join(parts) if parts else ""

    def _note_delivery(self, query: str, delivered: Optional[tuple]) -> None:
        """Remember, until this turn is synced, which prefetch it received: (usage id, transcript) or None.

        Keyed by the turn's text; the turn's sync takes the note and writes the id on its user line. When the text has
        more than one turn begun and not yet synced — a retried prompt whose first turn was never synced, a sync
        lagging a turn behind — which sync belongs to which turn cannot be proved: the text becomes ambiguous, every
        id noted under it is closed as unresolved, and its syncs write no record (until all of them are in). A turn
        whose synced text differs from its query (a multimodal message flattened another way) finds no note: its
        prefetch stays open until the session ends.
        """
        if self._agent_context != "primary":
            return   # writes nothing: the worker closes such rows (their transcript is never written)
        unresolved: List[tuple] = []
        with self._prefetch_lock:
            st = self._key_state(_norm_turn_text(query))
            st["noted"] += 1
            st["started"] = max(st["started"], st["noted"])   # a host that never calls on_turn_start
            if delivered is not None:
                if st["ambiguous"] or st["uid"] is not None:
                    unresolved.append(delivered)
                    st["ambiguous"] = True
                else:
                    st["uid"], st["path"] = delivered
            unresolved += self._settle_ambiguity(st)
            while len(self._pending_deliveries) > _PENDING_DELIVERIES_MAX:
                old = self._pending_deliveries.pop(next(iter(self._pending_deliveries)))
                if old["uid"] is not None:
                    unresolved.append((old["uid"], old["path"]))
        for uid, path in unresolved:
            self._record_outcome(path, uid, "unresolved")

    def _take_delivery(self, user_content: str) -> Optional[Dict[str, Any]]:
        """At a turn's sync: the record to write on its user line, or None. Settles the text's pending state."""
        with self._prefetch_lock:
            key = _norm_turn_text(user_content)
            st = self._pending_deliveries.get(key)
            if st is None:
                return None
            record = None if st["ambiguous"] or st["uid"] is None else {"usage_id": st["uid"], "at": _iso_ms(_now_ms())}
            st["uid"], st["path"] = None, ""
            st["started"] = max(0, st["started"] - 1)
            st["noted"] = max(0, st["noted"] - 1)
            if st["started"] == 0 and st["noted"] == 0:
                self._pending_deliveries.pop(key, None)
            return record

    def _record_outcome(self, transcript_path: str, usage_id: int, outcome: str) -> None:
        """Close a prefetch's row for ClawMem's feedback step: "dropped" (never handed over) or "unresolved" (handed
        over, but to a turn that cannot be proved). A line in the row's own transcript, identified by the row's id;
        a failed write keeps it for the next one (`_append_transcript`)."""
        if self._agent_context != "primary" or not transcript_path:
            return
        self._append_transcript([{"type": _OUTCOME_TYPE, "usage_id": usage_id, "outcome": outcome, "timestamp": ""}],
                                transcript_path)

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background: run context-surfacing hook for next turn."""
        if not self._bin or not query or len(query) < 5:
            return

        # Increment generation so older threads can't overwrite newer results,
        # and snapshot the session id + transcript path under the same lock so a
        # concurrent on_session_switch() can't make the worker read a torn
        # (new id / old path) pair — the worker uses the snapshot, never live state.
        # The count is taken with the snapshot, under the lock a session switch changes the path under, so the switch's
        # decision to let the old transcript go always sees it (T35 #2). Lock order: _prefetch_lock, then
        # _transcript_lock (nothing takes them the other way round).
        with self._prefetch_lock:
            self._prefetch_generation += 1
            my_gen = self._prefetch_generation
            run_session_id = self._session_id
            run_transcript_path = self._transcript_path
            with self._transcript_lock:
                self._inflight[run_transcript_path] = self._inflight.get(run_transcript_path, 0) + 1

        def _run():
            try:
                _prefetch()
            finally:
                self._prefetch_done(run_transcript_path)

        def _prefetch():
            hook_input = {
                "session_id": run_session_id,
                "transcript_path": run_transcript_path,
                "prompt": query,
                "hook_event_name": "UserPromptSubmit",
                "host": _HOST,
            }
            output = _run_hook(self._bin, "context-surfacing", hook_input,
                               env_extra=self._env_extra)
            ctx = _extract_context(output) if output else ""
            uid = _extract_usage_id(output) if output else None
            dropped: List[tuple] = []
            with self._prefetch_lock:
                # Only write if we're still the latest generation and no turn has consumed past it
                if ctx and my_gen == self._prefetch_generation and my_gen > self._prefetch_consumed_gen:
                    if self._prefetch_result_usage_id is not None:
                        dropped.append((self._prefetch_result_usage_id, self._prefetch_result_path))   # replaced unread
                    self._prefetch_result = ctx
                    self._prefetch_result_gen = my_gen
                    self._prefetch_result_usage_id = uid
                    self._prefetch_result_path = run_transcript_path
                elif uid is not None:
                    dropped.append((uid, run_transcript_path))   # superseded, or too late for its turn
            for u, pth in dropped:
                self._record_outcome(pth, u, "dropped")

        # Wait for any previous prefetch to finish
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="clawmem-prefetch"
        )
        try:
            self._prefetch_thread.start()
        except RuntimeError:
            self._prefetch_done(run_transcript_path)
            raise

    # -- Sync / transcript management ------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Append turn to plugin-managed transcript JSONL, then queue a Stop pass over it.

        Writes in Claude Code transcript format so ClawMem hooks can read it.
        Suppressed for non-primary agent contexts (subagent/cron/flush) so the
        vault never absorbs system-prompt or background-task content.

        The Stop-family hooks run after every synced turn, as Claude Code runs them
        after every response: decision-extractor and handoff-generator keep a cursor
        per transcript and process only the turns they have not processed, and
        feedback-loop decides each surfaced turn once, so every turn is extracted,
        digested and credited once. (Through v0.40.3 they ran at session end only,
        reading the last 200 messages.)

        The user line carries `clawmem_delivery` — which prefetch this turn received
        (the surfacing row's id, or null) and when — if prefetch() ran for it. If the
        write fails, the turn's lines wait and are written, in order, before the next
        write that succeeds; its Stop pass is queued when they are on disk.
        """
        if self._agent_context != "primary":
            return
        if not self._transcript_path:
            return
        session_id_now, transcript_path = self._session_id, self._transcript_path
        delivery = self._take_delivery(user_content)

        # Both lines are stamped together, as they join the transcript's writes (`_append_transcript`).
        user_line: Dict[str, Any] = {
            "type": "message",
            "message": {
                "role": "user",
                "content": user_content,
            },
            "timestamp": "",
        }
        if delivery is not None:
            user_line["clawmem_delivery"] = delivery
        self._append_transcript([user_line, {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": assistant_content,
            },
            "timestamp": "",
        }], transcript_path, session_id=session_id_now)

    def _append_transcript(self, entries: List[Dict[str, Any]], transcript_path: str, *, session_id: str = "") -> bool:
        """Append entries to a transcript, after anything still waiting for it; True when all of it is on disk.

        Nothing a failed write held is lost to it: its lines wait, in order, and later writes — of any transcript —
        retry them first, after a growing pause, as the session's end, a switch and shutdown do at once
        (`_flush_locked`); `_write_box` accounts for every byte. A turn's Stop pass (`session_id`) is queued once its
        lines are on disk. Past _OUTBOX_MAX waiting writes or _OUTBOX_MAX_BYTES for one transcript — a single
        oversized write included — the oldest is given up, with a warning, once an attempt to write it has failed.

        Each entry's `timestamp` is set here, under the lock that orders the writes, so a transcript's times never
        decrease down the file, whichever thread writes, unless the wall clock is set back (BACKLOG 69.14)."""
        with self._transcript_lock:
            ts = _iso_ms(_now_ms())
            for entry in entries:
                entry["timestamp"] = ts
            group = "".join(json.dumps(entry) + "\n" for entry in entries).encode("utf-8")
            box = self._outbox.setdefault(transcript_path, _new_box())
            box["groups"].append(group)
            box["bytes"] += len(group)
            if session_id:
                box["sid"] = session_id
            landed = self._flush_locked(force=False)
            box = self._outbox.get(transcript_path)
            ok = box is None
            if box is not None:   # still waiting: only now is anything given up, never what could be written
                while box["groups"] and (len(box["groups"]) > _OUTBOX_MAX or box["bytes"] > _OUTBOX_MAX_BYTES):
                    box["bytes"] -= len(box["groups"].pop(0))
                    box["done"] = 0   # a write cut short goes with it; the next write ends its torn tail
                    logger.warning("clawmem: transcript %s cannot be written; its oldest waiting write is given up",
                                   transcript_path)
                if not box["groups"]:
                    self._drop_box(transcript_path)
        self._queue_landed(landed)
        return ok

    def _flush_outbox(self) -> None:
        """Write every transcript's waiting lines now, whatever its pause (a session's end, a switch, shutdown)."""
        with self._transcript_lock:
            landed = self._flush_locked(force=True)
        self._queue_landed(landed)

    def _prefetch_done(self, path: str) -> None:
        """A prefetch for `path` has finished: a transcript no longer current, with nothing waiting for it, is let go."""
        with self._transcript_lock:
            n = self._inflight.get(path, 1) - 1
            if n > 0:
                self._inflight[path] = n
                return
            self._inflight.pop(path, None)
            if path != self._transcript_path and path not in self._outbox:
                self._release(path)

    def _queue_landed(self, landed: List[tuple]) -> None:
        for sid, path in landed:
            if sid:
                self._queue_stop_pass(sid, path)

    def _abandon(self, transcript_path: Optional[str], when: str) -> None:
        """Give up what still waits for a transcript (for every one when None), with a warning — so nothing written
        later can contradict a verdict made without it."""
        with self._transcript_lock:
            for path in (list(self._outbox) if transcript_path is None else [transcript_path]):
                box = self._outbox.get(path)
                if box and box["groups"]:
                    logger.warning("clawmem: %d transcript write(s) for %s lost at %s", len(box["groups"]), path, when)
                self._drop_box(path)

    def _drop_box(self, path: str) -> None:
        """Forget a transcript's waiting writes, and let go of a transcript this process no longer writes. Call under
        _transcript_lock."""
        self._outbox.pop(path, None)
        if path != self._transcript_path and not self._inflight.get(path):
            self._release(path)

    def _claim(self, session_id: str) -> str:
        """The transcript this process writes for `session_id`, held open and locked while it writes it (T33 #1, #5):
        `<id>.jsonl`, or — while another process holds that — `<id>.2.jsonl` … `<id>.8.jsonl`; where the platform or
        the file system cannot lock, a name of this process's own, `<id>.<random>.jsonl`, which no other process
        writes. So each transcript has one writer, and no other process's line ever lands inside a write of ours."""
        base = Path(self._hermes_home) / "clawmem-transcripts"
        base.mkdir(parents=True, exist_ok=True)
        with self._transcript_lock:
            for n in range(1, _CLAIM_TRIES + 1):
                path = str(base / (f"{session_id}.jsonl" if n == 1 else f"{session_id}.{n}.jsonl"))
                held = self._hold(path)
                if held:
                    return path
                if held is None:
                    break
            path = str(base / f"{session_id}.{uuid.uuid4().hex[:12]}.jsonl")
            self._own.add(path)
            self._hold(path)
            return path

    def _hold(self, path: str) -> Optional[bool]:
        """This process's open handle on a transcript, locked unless the name is its own (kept in _claims): True once
        held; False while another process holds it; None where it cannot be locked or opened. Call under
        _transcript_lock."""
        if path in self._claims:
            return True
        try:
            fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o644)
        except OSError as e:
            logger.debug("clawmem: transcript open failed: %s", e)
            return None
        held = True if path in self._own else _try_lock(fd)
        if held:
            self._claims[path] = fd
        else:
            os.close(fd)
        return held

    def _release(self, path: str) -> None:
        """Close this process's handle on a transcript (its lock goes with it). Call under _transcript_lock."""
        fd = self._claims.pop(path, None)
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    def _flush_locked(self, force: bool) -> List[tuple]:
        """Write each transcript's waiting lines, oldest first; one whose last attempt failed is tried again only after
        its pause, unless `force`. Returns (session id, path) of each that completed a write of its turns. Call under
        _transcript_lock."""
        landed: List[tuple] = []
        now = time.monotonic()
        for path in list(self._outbox):
            box = self._outbox[path]
            if not force and now < box["next_try"]:
                continue
            if self._write_box(path, box) and box["sid"]:
                landed.append((box["sid"], path))
            if not box["groups"]:
                self._drop_box(path)
            else:
                box["pause"] = min(_RETRY_MAX_S, max(_RETRY_MIN_S, box["pause"] * 2))
                box["next_try"] = now + box["pause"]
        return landed

    def _write_box(self, path: str, box: Dict[str, Any]) -> bool:
        """Append a transcript's waiting groups in order, on this process's handle on it (`_hold`); returns whether a
        group was completed.

        Every byte is accounted for and nothing is truncated, so nothing on disk is ever written twice or taken back: a
        group that stops part-way leaves `done` of its bytes on disk, and the next attempt goes on from its next byte.
        If the transcript changed meanwhile (a writer outside this protocol, an edit), the rest of that group is given
        up with a warning — appended after someone else's lines it would join another turn. A torn tail (a crash, a
        group given up) is ended first, so it stays a line of its own, which ClawMem skips. A new file opens with a
        small header line, dated by the line it opens and never later, so ClawMem can tell when the transcript began
        whatever the size of its first turn."""
        if not self._hold(path):
            return False   # another process holds it, or it cannot be opened: the writes wait
        fd = self._claims[path]
        if not _names_file(fd, path):
            # The pathname names another file now, or none (the transcript was moved or replaced): the old one is let
            # go and the file now at the path claimed (T34 #2). A write cut short is not finished there — the new file
            # may hold part of it, or none (T35 #1) — its rest is given up with a warning.
            self._release(path)
            logger.warning("clawmem: transcript %s was moved or replaced; writing on in the file now at that path", path)
            if box["done"] > 0:
                box["bytes"] -= len(box["groups"].pop(0))
                box["done"] = 0
                logger.warning("clawmem: the rest of a write cut short in the old %s is given up", path)
                if not box["groups"]:
                    return False
            if not self._hold(path):
                return False
            fd = self._claims[path]
        wrote = False
        size = os.fstat(fd).st_size
        if box["done"] > 0 and size != box["end"]:
            box["bytes"] -= len(box["groups"].pop(0))
            box["done"] = 0
            logger.warning("clawmem: transcript %s changed under a write cut short; the rest of it is given up", path)
            if not box["groups"]:
                return wrote
        start = box["done"]
        if start == 0:
            if size == 0:
                # Dated by the line it opens, never later: that line was stamped when it was queued, and this write can
                # come after a failed attempt's pause.
                stamp, first = _iso_ms(_now_ms()), (_first_stamp(box["groups"][0]) if box["groups"] else "")
                prefix = (json.dumps({"type": "clawmem-transcript", "host": _HOST, "timestamp": min(stamp, first or stamp)}) + "\n").encode("utf-8")
            elif _last_byte(fd, size) != b"\n":
                prefix = b"\n"
            else:
                prefix = b""
            n, ok = _write_all(fd, prefix)
            size += n
            if not ok:
                return wrote   # the groups did not move; the next attempt decides again from the file
        box["done"] = 0
        while box["groups"]:
            n, ok = _write_all(fd, memoryview(box["groups"][0])[start:])
            size += n
            if not ok:
                box["done"], box["end"] = start + n, size
                return wrote
            box["bytes"] -= len(box["groups"].pop(0))
            start = 0
            wrote = True
            if box["groups"] and not _names_file(fd, path):
                return wrote   # moved meanwhile: the rest goes to the file now at the path, at the next attempt (T35 #5)
        return wrote

    # -- Stop passes -----------------------------------------------------------

    def _hook_input(self, session_id: str, transcript_path: str, event: str) -> Dict[str, Any]:
        return {
            "session_id": session_id,
            "transcript_path": transcript_path,
            "hook_event_name": event,
            "host": _HOST,
        }

    def _run_stop_pass(self, session_id: str, transcript_path: str) -> None:
        """decision-extractor, handoff-generator and feedback-loop in parallel over one transcript (bounded)."""
        if not self._bin:
            return
        hook_input = self._hook_input(session_id, transcript_path, "Stop")
        threads = []
        for hook_name in _STOP_HOOKS:
            t = threading.Thread(
                target=_run_hook,
                args=(self._bin, hook_name, hook_input),
                kwargs={"env_extra": self._env_extra},
                daemon=True,
                name=f"clawmem-{hook_name}",
            )
            t.start()
            threads.append(t)
        for t in threads:
            t.join(timeout=_HOOK_TIMEOUT + 5)

    def _queue_stop_pass(self, session_id: str, transcript_path: str) -> None:
        """Run a Stop pass in the background. Passes never overlap: a request made while one runs waits, and
        requests for one transcript coalesce, since a pass resumes from the hooks' cursors whatever it was
        queued for. Each request carries its own session id and path, so a session switch cannot redirect it."""
        with self._stop_lock:
            self._stop_pending[(session_id, transcript_path)] = None
            if self._stop_thread is not None and self._stop_thread.is_alive():
                return
            self._stop_thread = threading.Thread(target=self._stop_loop, daemon=True, name="clawmem-stop")
            self._stop_thread.start()

    def _stop_loop(self) -> None:
        while True:
            with self._stop_lock:
                if not self._stop_pending:
                    self._stop_thread = None
                    return
                key = next(iter(self._stop_pending))
                del self._stop_pending[key]
                self._stop_running = key
            try:
                self._run_stop_pass(*key)
            except Exception as e:
                logger.debug("clawmem: stop pass failed: %s", e)
            finally:
                with self._stop_cond:
                    self._stop_running = None
                    self._stop_cond.notify_all()

    # -- Session end / compression hooks ---------------------------------------

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Finish the session's extraction: one more Stop pass, then the session end.

        Suppressed for non-primary agent contexts (subagent/cron/flush) — the
        decision-extractor / handoff-generator / feedback-loop pipeline would
        otherwise capture cron system prompts or subagent intermediate state
        as if it were primary-agent reasoning.

        Every synced turn already queued a pass. This transcript's final pass is
        taken out of the queue and run here, after a pass of it still running
        (passes of other transcripts do not delay it): it processes anything a
        failed or timed-out pass left, and is a no-op otherwise. If the running
        pass outlasts its bound, the final pass runs anyway — the hooks' cursors
        and verdict gates discard work done twice. Then handoff-generator's
        SessionEnd flush renders the handoff's latest turns and records the
        session's end (no transcript read, no model call), and a last
        feedback-loop run closes the final prefetch, whose context no later turn
        received; what a timed-out step leaves, the watcher's worker finishes.
        """
        if self._agent_context != "primary":
            return
        if not self._bin or not self._transcript_path:
            return
        session_id, transcript_path = self._session_id, self._transcript_path
        key = (session_id, transcript_path)
        # What a failed write left is written first, for the final pass to read; what still cannot be written is given
        # up (with a warning) before the session's end is recorded, so no later write contradicts a verdict made
        # without it.
        self._flush_outbox()
        self._abandon(transcript_path, "session end")

        with self._stop_cond:
            self._stop_pending.pop(key, None)
            self._stop_cond.wait_for(lambda: self._stop_running != key, timeout=_HOOK_TIMEOUT + 5)
        self._run_stop_pass(session_id, transcript_path)
        _run_hook(self._bin, "handoff-generator", self._hook_input(session_id, transcript_path, "SessionEnd"),
                  timeout=_SESSION_END_TIMEOUT, env_extra=self._env_extra)
        _run_hook(self._bin, "feedback-loop", self._hook_input(session_id, transcript_path, "Stop"),
                  env_extra=self._env_extra)

        logger.info("clawmem: session %s extraction complete", session_id[:8])

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs,
    ) -> None:
        """Refresh session-derived state when Hermes rotates session_id mid-process.

        Fires on /new (reset=True), /resume, /branch, and compression (reset=False).
        ClawMem reads _session_id and the session-keyed _transcript_path live in
        queue_prefetch / sync_turn / on_session_end / on_pre_compress, so a switch
        must repoint them and drop the prior session's prefetch + bootstrap context
        (unconditional — NOT gated on reset, or stale recall leaks into the new
        session). Cache coherence, not a vault write, so it runs for all contexts.
        """
        new_id = str(new_session_id or "").strip()
        if not new_id or not self._bin:
            return
        # Idempotent re-fire (duplicate dispatch) with no reset is a no-op.
        if new_id == self._session_id and not reset:
            return

        old_path = self._transcript_path
        new_path = self._transcript_path
        if self._hermes_home:
            transcript_dir = Path(self._hermes_home) / "clawmem-transcripts"
            transcript_dir.mkdir(parents=True, exist_ok=True)
            new_path = (self._claim(new_id) if self._agent_context == "primary"
                        else str(transcript_dir / f"{new_id}.jsonl"))

        closed: List[tuple] = []
        with self._prefetch_lock:
            self._session_id = new_id
            self._transcript_path = new_path
            # Bump generation MONOTONICALLY (never reset to 0): an in-flight
            # prefetch worker then fails its `my_gen == _prefetch_generation`
            # check and discards its result instead of leaking it into the new
            # session. Advancing consumed_gen drops any already-cached result.
            self._prefetch_generation += 1
            # What the old session leaves open is closed for ClawMem: a cached result never handed over is dropped;
            # a hand-over whose turn never synced (the session's syncs are all in by now) is unresolved.
            if self._prefetch_result_usage_id is not None:
                closed.append((self._prefetch_result_path, self._prefetch_result_usage_id, "dropped"))
            for st in self._pending_deliveries.values():
                if st["uid"] is not None:
                    closed.append((st["path"], st["uid"], "unresolved"))
            self._prefetch_result = ""
            self._prefetch_result_usage_id = None
            self._prefetch_result_path = ""
            self._pending_deliveries.clear()
            self._prefetch_result_gen = 0
            self._prefetch_consumed_gen = self._prefetch_generation
            # Startup context is session-derived; must not cross session ids.
            self._bootstrap_context = ""
        for path, uid, outcome in closed:
            self._record_outcome(path, uid, outcome)
        self._flush_outbox()
        with self._transcript_lock:
            if old_path != self._transcript_path and old_path not in self._outbox and not self._inflight.get(old_path):
                self._release(old_path)   # waiting writes, or a prefetch still running for it, keep it held

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Run precompact-extract (side effect only — Hermes ignores return).

        Suppressed for non-primary agent contexts so the session's pre-compaction
        state never picks up cron/subagent context as primary state.
        """
        if self._agent_context != "primary":
            return ""
        if not self._bin or not self._transcript_path:
            return ""

        hook_input = self._hook_input(self._session_id, self._transcript_path, "PreCompact")
        _run_hook(self._bin, "precompact-extract", hook_input, env_extra=self._env_extra)
        return ""

    # -- Tools (REST API) ------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [RETRIEVE_SCHEMA, GET_SCHEMA, SESSION_LOG_SCHEMA, TIMELINE_SCHEMA, SIMILAR_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "clawmem_retrieve":
                return self._tool_retrieve(args)
            elif tool_name == "clawmem_get":
                return self._tool_get(args)
            elif tool_name == "clawmem_session_log":
                return self._tool_session_log(args)
            elif tool_name == "clawmem_timeline":
                return self._tool_timeline(args)
            elif tool_name == "clawmem_similar":
                return self._tool_similar(args)
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _tool_retrieve(self, args: dict) -> str:
        query = args.get("query", "")
        if not query:
            return json.dumps({"error": "query is required"})
        body = {"query": query, "compact": True}
        if args.get("limit"):
            body["limit"] = args["limit"]
        data = _rest_call(self._port, "POST", "/retrieve", body)
        if data is None:
            return json.dumps({"error": "ClawMem REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_get(self, args: dict) -> str:
        docid = args.get("docid", "")
        if not docid:
            return json.dumps({"error": "docid is required"})
        data = _rest_call(self._port, "GET", f"/documents/{docid}")
        if data is None:
            return json.dumps({"error": f"Document not found: {docid}"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_session_log(self, args: dict) -> str:
        limit = args.get("limit", 5)
        data = _rest_call(self._port, "GET", f"/sessions?limit={limit}")
        if data is None:
            return json.dumps({"error": "ClawMem REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_timeline(self, args: dict) -> str:
        docid = args.get("docid", "")
        if not docid:
            return json.dumps({"error": "docid is required"})
        before = args.get("before", 5)
        after = args.get("after", 5)
        data = _rest_call(self._port, "GET", f"/timeline/{docid}?before={before}&after={after}")
        if data is None:
            return json.dumps({"error": "ClawMem REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    def _tool_similar(self, args: dict) -> str:
        docid = args.get("docid", "")
        if not docid:
            return json.dumps({"error": "docid is required"})
        limit = args.get("limit", 5)
        data = _rest_call(self._port, "GET", f"/graph/similar/{docid}?limit={limit}")
        if data is None:
            return json.dumps({"error": "ClawMem REST API unreachable"})
        return json.dumps(data, ensure_ascii=False)

    # -- Managed serve ---------------------------------------------------------

    def _start_serve(self) -> None:
        """Start clawmem serve as a managed child process with readiness probe."""
        if not self._bin:
            return
        try:
            env = {**os.environ, **self._env_extra}
            self._serve_proc = subprocess.Popen(
                [self._bin, "serve", "--port", str(self._port)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
            )
            # Readiness probe — wait up to 5s for /health to respond
            for attempt in range(10):
                # Check if process exited immediately (port conflict, crash)
                if self._serve_proc.poll() is not None:
                    logger.warning("clawmem: managed serve exited immediately (code=%d)",
                                   self._serve_proc.returncode)
                    self._serve_proc = None
                    return
                time.sleep(0.5)
                health = _rest_call(self._port, "GET", "/health", timeout=1.0)
                if health:
                    logger.info("clawmem: managed serve ready (pid=%d, port=%d)",
                                self._serve_proc.pid, self._port)
                    return
            logger.warning("clawmem: managed serve started but health check timed out (pid=%d)",
                           self._serve_proc.pid)
        except Exception as e:
            logger.warning("clawmem: failed to start managed serve: %s", e)

    # -- Shutdown --------------------------------------------------------------

    def shutdown(self) -> None:
        # Wait for background threads
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)

        # A last try at the transcript writes still waiting: what cannot be written now is lost with the process.
        self._flush_outbox()
        self._abandon(None, "shutdown")
        with self._transcript_lock:
            for path in list(self._claims):
                self._release(path)

        # Stop managed serve
        if self._serve_proc and self._serve_proc.poll() is None:
            self._serve_proc.terminate()
            try:
                self._serve_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._serve_proc.kill()
            logger.info("clawmem: managed serve stopped")


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register ClawMem as a memory provider plugin."""
    ctx.register_memory_provider(ClawMemProvider())
