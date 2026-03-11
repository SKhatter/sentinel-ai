"""
Agent Reliability SDK for Python
Instruments LLM agents, tool calls, and reasoning chains.
Sends traces to the Unified Observability Platform.

Usage:
    from agent_sdk import AgentTracer

    tracer = AgentTracer(endpoint="http://localhost:3001/api/agent/spans")

    with tracer.trace("support-agent", session_id="session_abc", user_id="user_123") as trace:
        with trace.span("llm_call", model="gpt-4o") as span:
            response = openai_client.chat.completions.create(...)
            span.set_tokens(prompt=response.usage.prompt_tokens,
                            completion=response.usage.completion_tokens)

        with trace.span("tool_call", tool_name="search_web") as span:
            result = search(query)
            span.set_output(result)
"""

import time
import uuid
import json
import threading
import requests
from datetime import datetime, timezone
from contextlib import contextmanager
from typing import Optional, Any, Dict


class Span:
    def __init__(self, trace_id: str, span_id: str, step_type: str,
                 agent_name: str, session_id: Optional[str], user_id: Optional[str],
                 parent_span_id: Optional[str] = None, **kwargs):
        self.trace_id = trace_id
        self.span_id = span_id
        self.parent_span_id = parent_span_id
        self.step_type = step_type
        self.agent_name = agent_name
        self.session_id = session_id
        self.user_id = user_id
        self.timestamp = datetime.now(timezone.utc).isoformat()
        self.start_time = time.time()
        self.latency_ms: Optional[int] = None
        self.error: Optional[str] = None
        self.retry_count: int = 0

        # LLM-specific
        self.model: Optional[str] = kwargs.get("model")
        self.prompt_tokens: Optional[int] = None
        self.completion_tokens: Optional[int] = None

        # Tool-specific
        self.tool_name: Optional[str] = kwargs.get("tool_name")
        self.tool_input: Optional[Any] = None
        self.tool_output: Optional[Any] = None

        # Extra metadata
        self.metadata: Dict = {}

    def set_tokens(self, prompt: int, completion: int):
        self.prompt_tokens = prompt
        self.completion_tokens = completion

    def set_input(self, data: Any):
        self.tool_input = data

    def set_output(self, data: Any):
        self.tool_output = data

    def set_error(self, error: str):
        self.error = error

    def set_retry(self, count: int):
        self.retry_count = count

    def set_metadata(self, **kwargs):
        self.metadata.update(kwargs)

    def finish(self):
        self.latency_ms = int((time.time() - self.start_time) * 1000)

    def to_dict(self) -> dict:
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "step_type": self.step_type,
            "agent_name": self.agent_name,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "timestamp": self.timestamp,
            "latency_ms": self.latency_ms,
            "model": self.model,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
            "tool_output": self.tool_output,
            "error": self.error,
            "retry_count": self.retry_count,
            **self.metadata
        }


class Trace:
    def __init__(self, trace_id: str, agent_name: str,
                 session_id: Optional[str], user_id: Optional[str],
                 tracer: "AgentTracer"):
        self.trace_id = trace_id
        self.agent_name = agent_name
        self.session_id = session_id
        self.user_id = user_id
        self.tracer = tracer
        self._spans = []

    @contextmanager
    def span(self, step_type: str, **kwargs):
        """Context manager for a single span within this trace."""
        span_id = "span_" + uuid.uuid4().hex[:12]
        s = Span(
            trace_id=self.trace_id,
            span_id=span_id,
            step_type=step_type,
            agent_name=self.agent_name,
            session_id=self.session_id,
            user_id=self.user_id,
            **kwargs
        )
        try:
            yield s
        except Exception as e:
            s.set_error(str(e))
            raise
        finally:
            s.finish()
            self._spans.append(s)
            self.tracer._enqueue(s)

    def _emit_lifecycle(self, step_type: str, error: Optional[str] = None):
        s = Span(
            trace_id=self.trace_id,
            span_id="span_" + uuid.uuid4().hex[:12],
            step_type=step_type,
            agent_name=self.agent_name,
            session_id=self.session_id,
            user_id=self.user_id
        )
        s.finish()
        if error:
            s.set_error(error)
        self._spans.append(s)
        self.tracer._enqueue(s)


class AgentTracer:
    """
    Main tracer class. Buffers spans and flushes them to the observability backend.

    Args:
        endpoint: URL of the agent spans API (default: http://localhost:3001/api/agent/spans)
        flush_interval: How often to flush buffered spans (seconds)
        batch_size: Max spans per batch
        debug: Print debug logs
    """

    def __init__(self,
                 endpoint: str = "http://localhost:3001/api/agent/spans",
                 flush_interval: float = 5.0,
                 batch_size: int = 50,
                 debug: bool = False):
        self.endpoint = endpoint
        self.flush_interval = flush_interval
        self.batch_size = batch_size
        self.debug = debug
        self._queue = []
        self._lock = threading.Lock()
        self._start_flush_thread()

    def _log(self, *args):
        if self.debug:
            print("[AgentTracer]", *args)

    def _start_flush_thread(self):
        def _loop():
            while True:
                time.sleep(self.flush_interval)
                self.flush()
        t = threading.Thread(target=_loop, daemon=True)
        t.start()

    def _enqueue(self, span: Span):
        with self._lock:
            self._queue.append(span.to_dict())
            if len(self._queue) >= self.batch_size:
                self._flush_locked()

    def flush(self):
        with self._lock:
            self._flush_locked()

    def _flush_locked(self):
        if not self._queue:
            return
        batch = self._queue[:]
        self._queue = []
        try:
            resp = requests.post(
                self.endpoint,
                json={"spans": batch},
                timeout=5
            )
            self._log(f"Flushed {len(batch)} spans → {resp.status_code}")
        except Exception as e:
            self._log(f"Failed to flush: {e}")
            # Re-queue on failure
            with self._lock:
                self._queue = batch + self._queue

    @contextmanager
    def trace(self, agent_name: str,
              session_id: Optional[str] = None,
              user_id: Optional[str] = None,
              trace_id: Optional[str] = None):
        """
        Context manager for a full agent trace (one complete run).

        Example:
            with tracer.trace("my-agent", session_id="s123", user_id="u456") as t:
                with t.span("llm_call", model="gpt-4o") as s:
                    ...
                    s.set_tokens(prompt=100, completion=50)
        """
        tid = trace_id or ("trace_" + uuid.uuid4().hex[:16])
        t = Trace(tid, agent_name, session_id, user_id, self)

        # Emit agent_start
        t._emit_lifecycle("agent_start")
        self._log(f"Trace started: {tid} ({agent_name})")

        error_msg = None
        try:
            yield t
        except Exception as e:
            error_msg = str(e)
            self._log(f"Trace failed: {e}")
            raise
        finally:
            # Emit agent_complete
            t._emit_lifecycle("agent_complete", error=error_msg)
            self.flush()
            self._log(f"Trace complete: {tid} | {len(t._spans)} spans")


# ─────────────────────────────────────────────────────────────
# DEMO: Simulate agent runs to populate the dashboard
# ─────────────────────────────────────────────────────────────

def run_demo():
    """
    Simulates several agent runs to demonstrate the SDK.
    Run this script directly: python agent_sdk.py
    """
    import random

    tracer = AgentTracer(
        endpoint="http://localhost:3001/api/agent/spans",
        flush_interval=2.0,
        debug=True
    )

    agents = ["support-agent", "search-agent", "code-assistant", "data-analyst"]
    models = ["gpt-4o", "gpt-3.5-turbo", "claude-3-sonnet", "claude-3-haiku"]
    tools  = ["search_web", "query_database", "send_email", "read_file", "call_api"]

    print("\n🚀 Agent Reliability SDK Demo")
    print("=" * 50)
    print(f"Sending traces to: http://localhost:3001")
    print(f"Dashboard: http://localhost:3001\n")

    for i in range(10):
        agent = random.choice(agents)
        model = random.choice(models)
        session_id = f"session_sdk_{i // 3}"
        user_id = f"user_sdk_{i % 5}"
        should_fail = (i % 5 == 0)
        should_loop = (i % 7 == 0)

        print(f"\n[{i+1}/10] Running {agent} (fail={should_fail}, loop={should_loop})")

        try:
            with tracer.trace(agent, session_id=session_id, user_id=user_id) as t:

                # LLM call
                with t.span("llm_call", model=model) as s:
                    time.sleep(random.uniform(0.3, 1.2))
                    s.set_tokens(
                        prompt=random.randint(500, 1500),
                        completion=random.randint(100, 400)
                    )
                    print(f"  🧠 LLM call ({model}) → {s.prompt_tokens}+{s.completion_tokens} tokens")

                # Tool calls
                tool_count = 6 if should_loop else random.randint(1, 3)
                for j in range(tool_count):
                    tool = "search_web" if should_loop else random.choice(tools)
                    with t.span("tool_call", tool_name=tool) as s:
                        time.sleep(random.uniform(0.1, 0.5))
                        if should_fail and j == tool_count - 1:
                            s.set_output("Error 500: Internal server error")
                            raise Exception("Tool execution failed")
                        else:
                            s.set_input({"query": f"demo query {j}"})
                            s.set_output({"result": "success", "data": f"result_{j}"})
                        print(f"  🔧 Tool: {tool} → {'ERROR' if should_fail and j == tool_count-1 else 'OK'}")

                # Second LLM call (reasoning/synthesis)
                with t.span("llm_call", model=model) as s:
                    time.sleep(random.uniform(0.2, 0.8))
                    s.set_tokens(
                        prompt=random.randint(800, 2000),
                        completion=random.randint(200, 600)
                    )
                    print(f"  🧠 Synthesis LLM call → done")

        except Exception as e:
            print(f"  ❌ Agent failed: {e}")

        time.sleep(0.5)

    print("\n✅ Demo complete! Check the dashboard at http://localhost:3001")
    print("   → Agent Overview: traces, success rate, latency")
    print("   → Incidents: detected loops and failures")
    print("   → SLOs: reliability targets")
    print("   → Cost & Tokens: model usage breakdown")


if __name__ == "__main__":
    run_demo()
