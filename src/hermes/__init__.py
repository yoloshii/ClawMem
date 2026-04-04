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
  CLAWMEM_RERANK_URL    — GPU reranker server URL (optional)
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_DEFAULT_PORT = 7438
_HOOK_TIMEOUT = 30  # seconds
_REST_TIMEOUT = 5.0  # seconds


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

        # Prefetch state (generation counter prevents stale overwrites)
        self._prefetch_result: str = ""
        self._prefetch_result_gen: int = 0  # generation of stored result
        self._prefetch_generation: int = 0  # latest queued generation
        self._prefetch_consumed_gen: int = 0  # last generation consumed by prefetch()
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None

        # Bootstrap context (consumed on first prefetch)
        self._bootstrap_context: str = ""

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

        # Build env for hook shell-outs (GPU endpoints, profile)
        for var in ("CLAWMEM_EMBED_URL", "CLAWMEM_LLM_URL", "CLAWMEM_RERANK_URL", "CLAWMEM_PROFILE"):
            val = os.environ.get(var)
            if val:
                self._env_extra[var] = val

        # Create transcript directory
        transcript_dir = Path(self._hermes_home) / "clawmem-transcripts"
        transcript_dir.mkdir(parents=True, exist_ok=True)
        self._transcript_path = str(transcript_dir / f"{session_id}.jsonl")

        # Start managed serve if configured
        if self._serve_mode == "managed":
            self._start_serve()

        # Run session-bootstrap hook
        hook_input = {
            "session_id": session_id,
            "transcript_path": self._transcript_path,
            "hook_event_name": "SessionStart",
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

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return cached prefetch result + any unconsumed bootstrap context."""
        # Wait for background thread if still running
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=3.0)

        parts = []

        # Consume bootstrap context (one-shot, first turn only)
        if self._bootstrap_context:
            parts.append(self._bootstrap_context)
            self._bootstrap_context = ""

        # Consume prefetched context only if it's from a generation we haven't consumed yet
        with self._prefetch_lock:
            if (self._prefetch_result
                    and self._prefetch_result_gen > self._prefetch_consumed_gen):
                parts.append(self._prefetch_result)
            # Always advance consumed_gen to current queued generation — this
            # prevents late-arriving results from leaking into the next turn
            self._prefetch_consumed_gen = self._prefetch_generation
            self._prefetch_result = ""

        return "\n\n".join(parts) if parts else ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background: run context-surfacing hook for next turn."""
        if not self._bin or not query or len(query) < 5:
            return

        # Increment generation so older threads can't overwrite newer results
        with self._prefetch_lock:
            self._prefetch_generation += 1
            my_gen = self._prefetch_generation

        def _run():
            hook_input = {
                "session_id": self._session_id,
                "transcript_path": self._transcript_path,
                "prompt": query,
                "hook_event_name": "UserPromptSubmit",
            }
            output = _run_hook(self._bin, "context-surfacing", hook_input,
                               env_extra=self._env_extra)
            if output:
                ctx = _extract_context(output)
                if ctx:
                    with self._prefetch_lock:
                        # Only write if we're still the latest generation
                        if my_gen == self._prefetch_generation:
                            self._prefetch_result = ctx
                            self._prefetch_result_gen = my_gen

        # Wait for any previous prefetch to finish
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="clawmem-prefetch"
        )
        self._prefetch_thread.start()

    # -- Sync / transcript management ------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Append turn to plugin-managed transcript JSONL.

        Writes in Claude Code transcript format so ClawMem hooks can read it.
        """
        if not self._transcript_path:
            return

        try:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            with open(self._transcript_path, "a") as f:
                # User message
                f.write(json.dumps({
                    "type": "message",
                    "message": {
                        "role": "user",
                        "content": user_content,
                    },
                    "timestamp": ts,
                }) + "\n")
                # Assistant message
                f.write(json.dumps({
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": assistant_content,
                    },
                    "timestamp": ts,
                }) + "\n")
        except Exception as e:
            logger.debug("clawmem: sync_turn write failed: %s", e)

    # -- Session end / compression hooks ---------------------------------------

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Run extraction hooks in parallel."""
        if not self._bin or not self._transcript_path:
            return

        hook_input = {
            "session_id": self._session_id,
            "transcript_path": self._transcript_path,
            "hook_event_name": "Stop",
        }

        threads = []
        for hook_name in ("decision-extractor", "handoff-generator", "feedback-loop"):
            t = threading.Thread(
                target=_run_hook,
                args=(self._bin, hook_name, hook_input),
                kwargs={"env_extra": self._env_extra},
                daemon=True,
                name=f"clawmem-{hook_name}",
            )
            t.start()
            threads.append(t)

        # Wait for all extraction hooks (bounded)
        for t in threads:
            t.join(timeout=_HOOK_TIMEOUT + 5)

        logger.info("clawmem: session %s extraction complete", self._session_id[:8])

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Run precompact-extract (side effect only — Hermes ignores return)."""
        if not self._bin or not self._transcript_path:
            return ""

        hook_input = {
            "session_id": self._session_id,
            "transcript_path": self._transcript_path,
            "hook_event_name": "PreCompact",
        }
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
