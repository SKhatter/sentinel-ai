/**
 * Sentinel.AI — Production Backend
 * ================================================
 * Features:
 *  - Multi-agent orchestration tracing (parent/child graphs)
 *  - Long-running workflow checkpointing
 *  - Rollback & Replay (state snapshots at every step)
 *  - Agent SLOs with error budgets & burn rate
 *  - Blast radius containment (dependency graph + circuit breakers)
 *  - Reliability guarantees (retry tracking, fallback chains, DLQ)
 *  - Web event ingestion (existing)
 */

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ============================================================
// STORAGE
// ============================================================

// Web events
const webEvents = [], webGaps = [];
const users = new Map(), sessions = new Map();

// Agent spans & traces
const agentSpans = [];
const agentTraces = new Map();       // trace_id → trace
const agentIncidents = [];

// Multi-agent orchestration
const workflows = new Map();         // workflow_id → workflow
const agentDependencyGraph = {};     // agent_name → Set of agents it calls

// Checkpoints (for replay)
const checkpoints = new Map();       // trace_id → [checkpoint, ...]

// Circuit breakers
const circuitBreakers = new Map();   // agent_name → { state, failures, last_failure, opened_at }

// Dead letter queue
const deadLetterQueue = [];

// Error budgets (per agent)
const errorBudgets = new Map();      // agent_name → { target, consumed, window_start }

// SLO config
const SLO_CONFIG = {
  default: { success_rate: 99, p95_latency_ms: 5000, tool_failure_rate: 1 },
  'support-agent': { success_rate: 99.5, p95_latency_ms: 3000, tool_failure_rate: 0.5 },
  'code-assistant': { success_rate: 98, p95_latency_ms: 10000, tool_failure_rate: 2 },
  'data-analyst': { success_rate: 97, p95_latency_ms: 15000, tool_failure_rate: 3 },
  'orchestrator': { success_rate: 99.9, p95_latency_ms: 30000, tool_failure_rate: 0.1 }
};

// Circuit breaker config
const CB_CONFIG = { failure_threshold: 3, recovery_timeout_ms: 60000 };

// Cache
let analyticsCache = null, analyticsCacheTime = 0;
let agentAnalyticsCache = null, agentAnalyticsCacheTime = 0;
const CACHE_TTL = 10000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
  if (req.path !== '/health') console.log(`${req.method} ${req.path}`);
  next();
});

// ============================================================
// STATIC ROUTES
// ============================================================
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/dashboard', (req, res) => res.sendFile(__dirname + '/dashboard.html'));
app.get('/demo', (req, res) => res.sendFile(__dirname + '/demo-app.html'));
app.get('/agent-demo', (req, res) => res.sendFile(__dirname + '/agent-demo.html'));

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => res.json({
  status: 'ok',
  web_events: webEvents.length,
  agent_spans: agentSpans.length,
  agent_traces: agentTraces.size,
  workflows: workflows.size,
  incidents: agentIncidents.length,
  circuit_breakers: Object.fromEntries(
    Array.from(circuitBreakers.entries()).map(([k,v]) => [k, v.state])
  ),
  dlq_size: deadLetterQueue.length
}));

// ============================================================
// WEB EVENT INGESTION
// ============================================================
app.post('/api/events', (req, res) => {
  try {
    const { events: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Events must be an array' });
    incoming.forEach(event => {
      const e = { ...event, id: genId(), received_at: new Date().toISOString() };
      webEvents.push(e);
      if (event.user_id) {
        if (!users.has(event.user_id)) users.set(event.user_id, { user_id: event.user_id, first_seen: e.timestamp, last_seen: e.timestamp, event_count: 0, sessions: new Set() });
        const u = users.get(event.user_id);
        u.last_seen = e.timestamp; u.event_count++;
        if (event.session_id) u.sessions.add(event.session_id);
      }
      if (event.session_id) {
        if (!sessions.has(event.session_id)) sessions.set(event.session_id, { session_id: event.session_id, user_id: event.user_id, started_at: e.timestamp, last_activity: e.timestamp, event_count: 0 });
        const s = sessions.get(event.session_id);
        s.last_activity = e.timestamp; s.event_count++;
      }
      if (event.event === 'gap_detected') webGaps.push({ id: genId(), gap_type: event.properties?.gap_type, user_id: event.user_id, session_id: event.session_id, timestamp: e.timestamp, details: event.properties });
    });
    analyticsCache = null;
    res.json({ success: true, processed: incoming.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// AGENT SPAN INGESTION
// ============================================================
app.post('/api/agent/spans', (req, res) => {
  try {
    const { spans: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Spans must be an array' });

    incoming.forEach(span => {
      const enriched = { ...span, id: genId(), received_at: new Date().toISOString() };
      agentSpans.push(enriched);

      // Build/update trace
      const tid = span.trace_id;
      if (!agentTraces.has(tid)) {
        agentTraces.set(tid, {
          trace_id: tid,
          agent_name: span.agent_name || 'unknown',
          workflow_id: span.workflow_id || null,
          parent_trace_id: span.parent_trace_id || null,
          session_id: span.session_id || null,
          user_id: span.user_id || null,
          started_at: span.timestamp,
          ended_at: null,
          status: 'running',
          spans: [],
          total_tokens: 0, total_cost_usd: 0, total_latency_ms: 0,
          error_count: 0, tool_calls: 0, llm_calls: 0,
          checkpoints: [],
          retry_count: 0,
          fallback_used: false
        });
      }

      const trace = agentTraces.get(tid);
      trace.spans.push(enriched);
      trace.ended_at = span.timestamp;
      if (span.latency_ms) trace.total_latency_ms += span.latency_ms;
      if (span.prompt_tokens || span.completion_tokens) {
        trace.total_tokens += (span.prompt_tokens || 0) + (span.completion_tokens || 0);
        trace.total_cost_usd += estimateCost(span.model, span.prompt_tokens || 0, span.completion_tokens || 0);
      }
      if (span.step_type === 'error' || span.error) trace.error_count++;
      if (span.step_type === 'tool_call') trace.tool_calls++;
      if (span.step_type === 'llm_call') trace.llm_calls++;
      if (span.retry_count) trace.retry_count = Math.max(trace.retry_count, span.retry_count);
      if (span.fallback_used) trace.fallback_used = true;
      if (span.step_type === 'agent_complete') trace.status = span.error ? 'failed' : 'completed';
      if (span.step_type === 'agent_start') trace.status = 'running';

      // Checkpoint: save state snapshot at every step
      if (span.step_type !== 'agent_start') {
        const cp = {
          checkpoint_id: genId(),
          span_id: span.span_id,
          step_type: span.step_type,
          timestamp: span.timestamp,
          state_snapshot: {
            tool_name: span.tool_name || null,
            tool_input: span.tool_input || null,
            tool_output: span.tool_output || null,
            model: span.model || null,
            prompt_tokens: span.prompt_tokens || null,
            completion_tokens: span.completion_tokens || null,
            error: span.error || null,
            latency_ms: span.latency_ms || null
          }
        };
        trace.checkpoints.push(cp);
        if (!checkpoints.has(tid)) checkpoints.set(tid, []);
        checkpoints.get(tid).push(cp);
      }

      // Update workflow if part of one
      if (span.workflow_id) updateWorkflow(span, trace);

      // Update dependency graph
      if (span.calls_agent) updateDependencyGraph(span.agent_name, span.calls_agent);

      // Circuit breaker logic
      updateCircuitBreaker(span.agent_name, span);

      // Error budget
      updateErrorBudget(span.agent_name, trace, span);

      // Failure detection
      detectFailures(trace, enriched);

      // DLQ: if agent_complete with error and retries exhausted
      if (span.step_type === 'agent_complete' && span.error && trace.retry_count >= 3) {
        deadLetterQueue.push({
          id: genId(),
          trace_id: tid,
          agent_name: trace.agent_name,
          workflow_id: trace.workflow_id,
          error: span.error,
          retry_count: trace.retry_count,
          timestamp: new Date().toISOString(),
          state_snapshot: trace.checkpoints[trace.checkpoints.length - 1] || null
        });
      }
    });

    agentAnalyticsCache = null;
    res.json({ success: true, processed: incoming.length });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ============================================================
// WORKFLOW INGESTION
// ============================================================
app.post('/api/workflows', (req, res) => {
  try {
    const { workflow_id, name, description, steps, metadata } = req.body;
    const wid = workflow_id || genId();
    workflows.set(wid, {
      workflow_id: wid,
      name: name || 'unnamed-workflow',
      description: description || '',
      steps: steps || [],
      metadata: metadata || {},
      created_at: new Date().toISOString(),
      status: 'running',
      completed_steps: [],
      failed_steps: [],
      current_step: null,
      traces: [],
      started_at: new Date().toISOString(),
      ended_at: null,
      total_duration_ms: 0
    });
    res.json({ workflow_id: wid, status: 'created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// MULTI-AGENT ORCHESTRATION HELPERS
// ============================================================
function updateWorkflow(span, trace) {
  const wid = span.workflow_id;
  if (!workflows.has(wid)) {
    workflows.set(wid, {
      workflow_id: wid,
      name: span.workflow_name || 'auto-detected-workflow',
      description: '',
      steps: [],
      status: 'running',
      completed_steps: [],
      failed_steps: [],
      current_step: span.agent_name,
      traces: [],
      started_at: span.timestamp,
      ended_at: null,
      total_duration_ms: 0
    });
  }
  const wf = workflows.get(wid);
  if (!wf.traces.includes(trace.trace_id)) wf.traces.push(trace.trace_id);
  wf.current_step = span.agent_name;

  if (span.step_type === 'agent_complete') {
    if (span.error) {
      if (!wf.failed_steps.includes(span.agent_name)) wf.failed_steps.push(span.agent_name);
      // Detect cascading failure: if orchestrator fails, mark all downstream
      if (span.agent_name === 'orchestrator' || wf.failed_steps.length >= 2) {
        wf.status = 'failed';
        wf.ended_at = span.timestamp;
        createIncident(trace, 'cascading_failure', {
          workflow_id: wid,
          failed_agents: wf.failed_steps,
          description: `Cascading failure in workflow "${wf.name}": ${wf.failed_steps.join(' → ')} failed`
        });
      }
    } else {
      if (!wf.completed_steps.includes(span.agent_name)) wf.completed_steps.push(span.agent_name);
    }
    // Check if all steps done
    const allAgents = new Set(wf.traces.map(tid => agentTraces.get(tid)?.agent_name).filter(Boolean));
    const allDone = [...allAgents].every(a => wf.completed_steps.includes(a) || wf.failed_steps.includes(a));
    if (allDone && wf.status === 'running') {
      wf.status = wf.failed_steps.length > 0 ? 'partial' : 'completed';
      wf.ended_at = span.timestamp;
      wf.total_duration_ms = new Date(wf.ended_at) - new Date(wf.started_at);
    }
  }
}

function updateDependencyGraph(from, to) {
  if (!agentDependencyGraph[from]) agentDependencyGraph[from] = new Set();
  agentDependencyGraph[from].add(to);
}

// ============================================================
// CIRCUIT BREAKER
// ============================================================
function updateCircuitBreaker(agentName, span) {
  if (!circuitBreakers.has(agentName)) {
    circuitBreakers.set(agentName, { state: 'closed', failures: 0, last_failure: null, opened_at: null, total_trips: 0 });
  }
  const cb = circuitBreakers.get(agentName);

  // Auto-recover if timeout passed
  if (cb.state === 'open' && cb.opened_at) {
    const elapsed = Date.now() - new Date(cb.opened_at).getTime();
    if (elapsed > CB_CONFIG.recovery_timeout_ms) {
      cb.state = 'half-open';
      cb.failures = 0;
    }
  }

  if (span.error || (span.step_type === 'agent_complete' && span.error)) {
    cb.failures++;
    cb.last_failure = span.timestamp;
    if (cb.failures >= CB_CONFIG.failure_threshold && cb.state !== 'open') {
      cb.state = 'open';
      cb.opened_at = new Date().toISOString();
      cb.total_trips++;
      createIncident({ trace_id: span.trace_id, agent_name: agentName, session_id: span.session_id, user_id: span.user_id }, 'circuit_breaker_open', {
        agent_name: agentName,
        failures: cb.failures,
        description: `Circuit breaker OPEN for "${agentName}" after ${cb.failures} consecutive failures. Auto-recovery in 60s.`
      });
    }
  } else if (span.step_type === 'agent_complete' && !span.error) {
    if (cb.state === 'half-open') cb.state = 'closed';
    cb.failures = Math.max(0, cb.failures - 1);
  }
}

// ============================================================
// ERROR BUDGET
// ============================================================
function updateErrorBudget(agentName, trace, span) {
  if (span.step_type !== 'agent_complete') return;
  const slo = SLO_CONFIG[agentName] || SLO_CONFIG.default;
  const windowMs = 24 * 60 * 60 * 1000; // 24h window

  if (!errorBudgets.has(agentName)) {
    errorBudgets.set(agentName, {
      agent_name: agentName,
      slo_target: slo.success_rate,
      window_start: new Date().toISOString(),
      total_runs: 0,
      failed_runs: 0,
      budget_consumed_pct: 0,
      burn_rate: 0,
      projected_exhaustion: null
    });
  }

  const budget = errorBudgets.get(agentName);
  budget.total_runs++;
  if (span.error) budget.failed_runs++;

  const errorRate = budget.total_runs > 0 ? (budget.failed_runs / budget.total_runs * 100) : 0;
  const allowedErrorRate = 100 - slo.success_rate;
  budget.budget_consumed_pct = allowedErrorRate > 0 ? Math.min(100, (errorRate / allowedErrorRate * 100)) : 0;

  // Burn rate: how fast we're consuming budget (1.0 = normal, >1 = burning fast)
  const windowHours = (Date.now() - new Date(budget.window_start).getTime()) / 3600000;
  budget.burn_rate = windowHours > 0 ? (budget.budget_consumed_pct / (windowHours / 24)) : 0;

  // Project exhaustion
  if (budget.burn_rate > 0 && budget.budget_consumed_pct < 100) {
    const hoursToExhaustion = (100 - budget.budget_consumed_pct) / (budget.burn_rate / 24);
    budget.projected_exhaustion = new Date(Date.now() + hoursToExhaustion * 3600000).toISOString();
  }

  // Alert if burn rate > 2x (will exhaust budget in half the window)
  if (budget.burn_rate > 2 && budget.budget_consumed_pct > 10) {
    createIncident({ trace_id: span.trace_id, agent_name: agentName, session_id: span.session_id, user_id: span.user_id }, 'error_budget_burn', {
      agent_name: agentName,
      burn_rate: budget.burn_rate.toFixed(2),
      consumed_pct: budget.budget_consumed_pct.toFixed(1),
      description: `Error budget burn rate ${budget.burn_rate.toFixed(1)}x for "${agentName}". Budget ${budget.budget_consumed_pct.toFixed(0)}% consumed. Projected exhaustion: ${budget.projected_exhaustion ? new Date(budget.projected_exhaustion).toLocaleString() : 'soon'}`
    });
  }
}

// ============================================================
// FAILURE DETECTION
// ============================================================
function detectFailures(trace, span) {
  // Agent loop
  if (span.step_type === 'tool_call' && span.tool_name) {
    const count = trace.spans.filter(s => s.step_type === 'tool_call' && s.tool_name === span.tool_name).length;
    if (count >= 5) createIncident(trace, 'agent_loop', { tool_name: span.tool_name, call_count: count, description: `Tool "${span.tool_name}" called ${count}x — possible infinite loop` });
  }
  // Silent tool failure
  if (span.step_type === 'tool_call' && span.tool_output) {
    const out = JSON.stringify(span.tool_output);
    if (/error|404|500|failed|exception/i.test(out)) {
      createIncident(trace, 'silent_tool_failure', { tool_name: span.tool_name, output: out.substring(0, 200), description: `Tool "${span.tool_name}" returned error response silently` });
    }
  }
  // Latency spike
  if (span.latency_ms > 10000) createIncident(trace, 'latency_spike', { latency_ms: span.latency_ms, step_type: span.step_type, description: `Step "${span.step_type}" took ${(span.latency_ms/1000).toFixed(1)}s` });
  // Explicit error
  if (span.error) createIncident(trace, 'agent_error', { error: span.error, step_type: span.step_type, description: `Error in "${span.step_type}": ${span.error}` });
  // Excessive retries
  if (span.retry_count >= 3) createIncident(trace, 'excessive_retries', { retry_count: span.retry_count, description: `Step "${span.step_type}" retried ${span.retry_count}x` });
  // Stalled workflow: no activity for 5+ minutes
  if (trace.workflow_id) {
    const wf = workflows.get(trace.workflow_id);
    if (wf && wf.status === 'running') {
      const lastActivity = new Date(trace.ended_at || trace.started_at).getTime();
      if (Date.now() - lastActivity > 5 * 60 * 1000) {
        createIncident(trace, 'stalled_workflow', { workflow_id: trace.workflow_id, description: `Workflow "${wf.name}" has had no activity for 5+ minutes` });
      }
    }
  }
}

function createIncident(trace, type, details) {
  const exists = agentIncidents.find(i => i.trace_id === trace.trace_id && i.incident_type === type);
  if (exists) return;
  agentIncidents.push({
    id: genId(),
    trace_id: trace.trace_id,
    agent_name: trace.agent_name,
    workflow_id: trace.workflow_id || null,
    session_id: trace.session_id,
    user_id: trace.user_id,
    incident_type: type,
    severity: incidentSeverity(type),
    timestamp: new Date().toISOString(),
    details,
    resolved: false
  });
}

function incidentSeverity(type) {
  return { agent_loop: 'critical', cascading_failure: 'critical', circuit_breaker_open: 'critical', agent_error: 'high', silent_tool_failure: 'high', error_budget_burn: 'high', partial_completion: 'high', latency_spike: 'medium', excessive_retries: 'medium', stalled_workflow: 'medium' }[type] || 'low';
}

// ============================================================
// BLAST RADIUS API
// ============================================================
app.get('/api/agent/blast-radius/:agentName', (req, res) => {
  try {
    const { agentName } = req.params;
    const affected = computeBlastRadius(agentName);
    res.json(affected);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function computeBlastRadius(agentName) {
  // BFS through dependency graph to find all downstream agents
  const visited = new Set();
  const queue = [agentName];
  const affected = [];

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const deps = agentDependencyGraph[current] || new Set();
    deps.forEach(dep => {
      if (!visited.has(dep)) {
        affected.push({ agent: dep, distance: affected.length + 1 });
        queue.push(dep);
      }
    });
  }

  // Count affected users/sessions
  const affectedTraces = Array.from(agentTraces.values()).filter(t =>
    affected.map(a => a.agent).includes(t.agent_name)
  );
  const affectedUsers = new Set(affectedTraces.map(t => t.user_id).filter(Boolean));
  const affectedSessions = new Set(affectedTraces.map(t => t.session_id).filter(Boolean));

  return {
    source_agent: agentName,
    downstream_agents: affected,
    affected_users: affectedUsers.size,
    affected_sessions: affectedSessions.size,
    affected_workflows: [...new Set(affectedTraces.map(t => t.workflow_id).filter(Boolean))],
    dependency_graph: Object.fromEntries(
      Object.entries(agentDependencyGraph).map(([k, v]) => [k, [...v]])
    )
  };
}

// ============================================================
// REPLAY API
// ============================================================
app.get('/api/agent/traces/:traceId/checkpoints', (req, res) => {
  try {
    const cps = checkpoints.get(req.params.traceId) || [];
    res.json(cps);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/traces/:traceId/replay', (req, res) => {
  try {
    const { from_checkpoint_id, modified_inputs } = req.body;
    const trace = agentTraces.get(req.params.traceId);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });

    const cps = checkpoints.get(req.params.traceId) || [];
    const fromIdx = from_checkpoint_id
      ? cps.findIndex(c => c.checkpoint_id === from_checkpoint_id)
      : 0;

    const replayId = 'replay_' + genId();
    res.json({
      replay_id: replayId,
      original_trace_id: req.params.traceId,
      replay_from_step: fromIdx,
      checkpoint_count: cps.length - fromIdx,
      agent_name: trace.agent_name,
      modified_inputs: modified_inputs || null,
      status: 'replay_queued',
      message: `Replay queued from step ${fromIdx + 1}/${cps.length}. In production, this would re-execute the agent from this checkpoint with the modified inputs.`
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// WORKFLOW API
// ============================================================
app.get('/api/workflows', (req, res) => {
  try {
    const wfs = Array.from(workflows.values())
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
      .slice(0, 50);
    res.json(wfs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/workflows/:workflowId', (req, res) => {
  try {
    const wf = workflows.get(req.params.workflowId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const wfTraces = wf.traces.map(tid => agentTraces.get(tid)).filter(Boolean);
    res.json({ ...wf, trace_details: wfTraces });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// CIRCUIT BREAKER API
// ============================================================
app.get('/api/agent/circuit-breakers', (req, res) => {
  try {
    const cbs = Array.from(circuitBreakers.entries()).map(([name, cb]) => ({
      agent_name: name,
      ...cb,
      opened_at: cb.opened_at,
      recovery_in_ms: cb.state === 'open' && cb.opened_at
        ? Math.max(0, CB_CONFIG.recovery_timeout_ms - (Date.now() - new Date(cb.opened_at).getTime()))
        : null
    }));
    res.json(cbs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/circuit-breakers/:agentName/reset', (req, res) => {
  try {
    const cb = circuitBreakers.get(req.params.agentName);
    if (!cb) return res.status(404).json({ error: 'Circuit breaker not found' });
    cb.state = 'closed'; cb.failures = 0; cb.opened_at = null;
    res.json({ agent_name: req.params.agentName, state: 'closed', message: 'Circuit breaker manually reset' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ERROR BUDGET API
// ============================================================
app.get('/api/agent/error-budgets', (req, res) => {
  try {
    res.json(Array.from(errorBudgets.values()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// DEAD LETTER QUEUE API
// ============================================================
app.get('/api/agent/dlq', (req, res) => {
  try {
    res.json(deadLetterQueue.slice(-50).reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/dlq/:id/retry', (req, res) => {
  try {
    const item = deadLetterQueue.find(d => d.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'DLQ item not found' });
    item.retried_at = new Date().toISOString();
    item.status = 'retried';
    res.json({ ...item, message: 'Retry queued. In production, this would re-submit the task to the agent.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// EXISTING AGENT ANALYTICS API
// ============================================================
app.get('/api/agent/analytics', (req, res) => {
  try {
    const now = Date.now();
    if (agentAnalyticsCache && (now - agentAnalyticsCacheTime) < CACHE_TTL) return res.json(agentAnalyticsCache);
    const data = calcAgentAnalytics();
    agentAnalyticsCache = data; agentAnalyticsCacheTime = now;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/traces', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const traces = Array.from(agentTraces.values())
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
      .slice(0, limit)
      .map(t => ({ ...t, spans: t.spans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)) }));
    res.json(traces);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/traces/:traceId', (req, res) => {
  try {
    const trace = agentTraces.get(req.params.traceId);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    const correlatedWeb = trace.session_id ? webEvents.filter(e => e.session_id === trace.session_id) : [];
    res.json({ ...trace, spans: trace.spans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)), correlated_web_events: correlatedWeb, checkpoints: checkpoints.get(req.params.traceId) || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/incidents', (req, res) => {
  try {
    res.json(agentIncidents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 100));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/agent/incidents/:id/resolve', (req, res) => {
  try {
    const inc = agentIncidents.find(i => i.id === req.params.id);
    if (!inc) return res.status(404).json({ error: 'Not found' });
    inc.resolved = true; inc.resolved_at = new Date().toISOString();
    res.json(inc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/slos', (req, res) => {
  try { res.json(calcSLOs()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics', (req, res) => {
  try {
    const now = Date.now();
    if (analyticsCache && (now - analyticsCacheTime) < CACHE_TTL) return res.json(analyticsCache);
    const data = calcWebAnalytics();
    analyticsCache = data; analyticsCacheTime = now;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gaps', (req, res) => {
  try {
    const grouped = webGaps.reduce((acc, g) => {
      if (!acc[g.gap_type]) acc[g.gap_type] = { gap_type: g.gap_type, count: 0, users: new Set(), sessions: new Set() };
      acc[g.gap_type].count++;
      acc[g.gap_type].users.add(g.user_id);
      acc[g.gap_type].sessions.add(g.session_id);
      return acc;
    }, {});
    res.json(Object.values(grouped).map(g => ({ ...g, users: g.users.size, sessions: g.sessions.size, impact_score: g.count * 0.3 + g.users.size * 0.7, estimated_revenue_opportunity: g.users.size * 50 })).sort((a, b) => b.impact_score - a.impact_score));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ANALYTICS CALCULATIONS
// ============================================================
function calcAgentAnalytics() {
  const all = Array.from(agentTraces.values());
  const completed = all.filter(t => t.status === 'completed');
  const failed = all.filter(t => t.status === 'failed');
  const total = completed.length + failed.length;
  const successRate = total > 0 ? (completed.length / total * 100).toFixed(1) : 100;
  const latencies = completed.map(t => t.total_latency_ms).sort((a, b) => a - b);
  const toolStats = {}, modelStats = {}, agentStats = {};

  agentSpans.filter(s => s.step_type === 'tool_call').forEach(s => {
    const n = s.tool_name || 'unknown';
    if (!toolStats[n]) toolStats[n] = { calls: 0, errors: 0, total_latency: 0 };
    toolStats[n].calls++;
    if (s.error || /error|404|500/i.test(JSON.stringify(s.tool_output || ''))) toolStats[n].errors++;
    if (s.latency_ms) toolStats[n].total_latency += s.latency_ms;
  });

  agentSpans.filter(s => s.step_type === 'llm_call' && s.model).forEach(s => {
    if (!modelStats[s.model]) modelStats[s.model] = { calls: 0, tokens: 0, cost: 0 };
    modelStats[s.model].calls++;
    modelStats[s.model].tokens += (s.prompt_tokens || 0) + (s.completion_tokens || 0);
    modelStats[s.model].cost += estimateCost(s.model, s.prompt_tokens || 0, s.completion_tokens || 0);
  });

  all.forEach(t => {
    if (!agentStats[t.agent_name]) agentStats[t.agent_name] = { runs: 0, success: 0, failed: 0, total_cost: 0, total_latency: 0 };
    agentStats[t.agent_name].runs++;
    if (t.status === 'completed') agentStats[t.agent_name].success++;
    if (t.status === 'failed') agentStats[t.agent_name].failed++;
    agentStats[t.agent_name].total_cost += t.total_cost_usd;
    agentStats[t.agent_name].total_latency += t.total_latency_ms;
  });

  const now = new Date();
  const last24h = new Date(now - 24 * 3600000);
  const recent = all.filter(t => new Date(t.started_at) > last24h);
  const timeline = genAgentTimeline(recent);
  const openIncidents = agentIncidents.filter(i => !i.resolved);

  return {
    overview: {
      total_traces: all.length,
      total_spans: agentSpans.length,
      success_rate: parseFloat(successRate),
      failed_traces: failed.length,
      open_incidents: openIncidents.length,
      total_tokens: all.reduce((s, t) => s + t.total_tokens, 0),
      total_cost_usd: parseFloat(all.reduce((s, t) => s + t.total_cost_usd, 0).toFixed(4)),
      active_agents: Object.keys(agentStats).length,
      active_workflows: Array.from(workflows.values()).filter(w => w.status === 'running').length,
      dlq_size: deadLetterQueue.length,
      open_circuit_breakers: Array.from(circuitBreakers.values()).filter(cb => cb.state === 'open').length
    },
    latency: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99) },
    top_tools: Object.entries(toolStats).map(([name, s]) => ({ name, calls: s.calls, error_rate: s.calls > 0 ? (s.errors / s.calls * 100).toFixed(1) : 0, avg_latency_ms: s.calls > 0 ? Math.round(s.total_latency / s.calls) : 0 })).sort((a, b) => b.calls - a.calls),
    model_usage: Object.entries(modelStats).map(([model, s]) => ({ model, calls: s.calls, tokens: s.tokens, cost_usd: parseFloat(s.cost.toFixed(4)) })),
    agent_breakdown: Object.entries(agentStats).map(([name, s]) => ({ agent_name: name, runs: s.runs, success: s.success, failed: s.failed, success_rate: s.runs > 0 ? (s.success / s.runs * 100).toFixed(1) : 100, avg_cost_usd: s.runs > 0 ? parseFloat((s.total_cost / s.runs).toFixed(4)) : 0, avg_latency_ms: s.runs > 0 ? Math.round(s.total_latency / s.runs) : 0 })),
    incident_summary: openIncidents.reduce((acc, i) => { acc[i.incident_type] = (acc[i.incident_type] || 0) + 1; return acc; }, {}),
    timeline,
    recent_traces: all.sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).slice(0, 10).map(t => ({ trace_id: t.trace_id, agent_name: t.agent_name, workflow_id: t.workflow_id, status: t.status, started_at: t.started_at, total_latency_ms: t.total_latency_ms, total_tokens: t.total_tokens, total_cost_usd: parseFloat(t.total_cost_usd.toFixed(4)), span_count: t.spans.length, error_count: t.error_count }))
  };
}

function calcSLOs() {
  const all = Array.from(agentTraces.values());
  const completed = all.filter(t => t.status === 'completed');
  const failed = all.filter(t => t.status === 'failed');
  const total = completed.length + failed.length;
  const successRate = total > 0 ? (completed.length / total * 100) : 100;
  const latencies = completed.map(t => t.total_latency_ms).sort((a, b) => a - b);
  const p95 = pct(latencies, 95);
  const toolSpans = agentSpans.filter(s => s.step_type === 'tool_call');
  const toolErrors = toolSpans.filter(s => s.error || /error|404|500/i.test(JSON.stringify(s.tool_output || '')));
  const toolFailRate = toolSpans.length > 0 ? (toolErrors.length / toolSpans.length * 100) : 0;
  const cfg = SLO_CONFIG.default;

  return {
    success_rate: { target: cfg.success_rate, current: parseFloat(successRate.toFixed(2)), status: successRate >= cfg.success_rate ? 'ok' : 'breached', total_runs: total },
    p95_latency: { target_ms: cfg.p95_latency_ms, current_ms: p95, status: p95 <= cfg.p95_latency_ms ? 'ok' : 'breached', sample_size: latencies.length },
    tool_failure_rate: { target: cfg.tool_failure_rate, current: parseFloat(toolFailRate.toFixed(2)), status: toolFailRate <= cfg.tool_failure_rate ? 'ok' : 'breached', total_tool_calls: toolSpans.length }
  };
}

function calcWebAnalytics() {
  const now = new Date();
  const last24h = new Date(now - 24 * 3600000);
  const last7d = new Date(now - 7 * 24 * 3600000);
  const recent = webEvents.filter(e => new Date(e.timestamp) > last24h);
  const week = webEvents.filter(e => new Date(e.timestamp) > last7d);
  const eventTypes = webEvents.reduce((acc, e) => { acc[e.event] = (acc[e.event] || 0) + 1; return acc; }, {});
  const pageStats = webEvents.filter(e => e.event === 'page_view').reduce((acc, e) => { const p = e.properties?.path || 'unknown'; acc[p] = (acc[p] || 0) + 1; return acc; }, {});
  const clickStats = webEvents.filter(e => e.event === 'click').reduce((acc, e) => { const k = `${e.properties?.selector || 'unknown'}:${(e.properties?.text || '').substring(0, 30)}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const avgDur = Array.from(sessions.values()).map(s => Math.round((new Date(s.last_activity) - new Date(s.started_at)) / 1000)).reduce((a, b) => a + b, 0) / (sessions.size || 1);

  return {
    overview: { total_events: webEvents.length, total_users: users.size, total_sessions: sessions.size, total_gaps: webGaps.length, active_users_24h: new Set(recent.map(e => e.user_id)).size, active_users_7d: new Set(week.map(e => e.user_id)).size, error_rate: parseFloat(recent.length > 0 ? (recent.filter(e => e.event === 'error').length / recent.length * 100).toFixed(2) : 0) },
    event_distribution: Object.entries(eventTypes).map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count),
    top_pages: Object.entries(pageStats).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, views]) => ({ path, views })),
    top_clicks: Object.entries(clickStats).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, clicks]) => { const [selector, text] = key.split(':'); return { selector, text, clicks }; }),
    session_stats: { avg_duration_seconds: Math.round(avgDur), avg_events_per_session: Math.round(webEvents.length / (sessions.size || 1) * 10) / 10 },
    recent_activity: recent.slice(-20).reverse(),
    timeline: genWebTimeline(week)
  };
}

// ============================================================
// HELPERS
// ============================================================
function genId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }
function pct(arr, p) { if (!arr.length) return 0; return arr[Math.max(0, Math.ceil(p / 100 * arr.length) - 1)] || 0; }
function estimateCost(model, p, c) {
  const pricing = { 'gpt-5.2': { input: 0.015, output: 0.06 }, 'gpt-5': { input: 0.01, output: 0.04 }, 'gpt-4o': { input: 0.005, output: 0.015 }, 'gpt-4': { input: 0.03, output: 0.06 }, 'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }, 'claude-3-opus': { input: 0.015, output: 0.075 }, 'claude-3-sonnet': { input: 0.003, output: 0.015 }, 'claude-3-haiku': { input: 0.00025, output: 0.00125 } };
  const pr = pricing[model] || { input: 0.002, output: 0.002 };
  return (p / 1000 * pr.input) + (c / 1000 * pr.output);
}
function genWebTimeline(events) {
  const hourly = {};
  const now = new Date();
  for (let i = 23; i >= 0; i--) { const h = new Date(now - i * 3600000).toISOString().substring(0, 13); hourly[h] = { timestamp: h, events: 0, users: new Set() }; }
  events.forEach(e => { const h = e.timestamp.substring(0, 13); if (hourly[h]) { hourly[h].events++; hourly[h].users.add(e.user_id); } });
  return Object.values(hourly).map(h => ({ timestamp: h.timestamp, events: h.events, users: h.users.size }));
}
function genAgentTimeline(traces) {
  const hourly = {};
  const now = new Date();
  for (let i = 23; i >= 0; i--) { const h = new Date(now - i * 3600000).toISOString().substring(0, 13); hourly[h] = { timestamp: h, runs: 0, failures: 0, total_latency: 0 }; }
  traces.forEach(t => { const h = t.started_at.substring(0, 13); if (hourly[h]) { hourly[h].runs++; if (t.status === 'failed') hourly[h].failures++; hourly[h].total_latency += t.total_latency_ms; } });
  return Object.values(hourly).map(h => ({ timestamp: h.timestamp, runs: h.runs, failures: h.failures, avg_latency_ms: h.runs > 0 ? Math.round(h.total_latency / h.runs) : 0 }));
}

// ============================================================
// SEED DEMO DATA
// ============================================================
function seedDemoData() {
  console.log('🌱 Seeding demo data...');
  const now = new Date();
  const agents = ['support-agent', 'search-agent', 'code-assistant', 'data-analyst'];
  const models = ['gpt-5.2', 'gpt-4o', 'claude-3-sonnet', 'claude-3-haiku'];
  const tools = ['search_web', 'query_database', 'send_email', 'read_file', 'call_api'];

  // Seed multi-agent workflow
  const wfId = 'workflow_demo_1';
  workflows.set(wfId, {
    workflow_id: wfId, name: 'customer-onboarding-pipeline',
    description: 'Multi-agent workflow: intake → research → personalize → notify',
    steps: ['intake-agent', 'research-agent', 'personalization-agent', 'notification-agent'],
    status: 'partial', completed_steps: ['intake-agent', 'research-agent'],
    failed_steps: ['personalization-agent'], current_step: 'notification-agent',
    traces: [], started_at: new Date(now - 2 * 3600000).toISOString(),
    ended_at: new Date(now - 1 * 3600000).toISOString(), total_duration_ms: 3600000
  });

  // Seed dependency graph
  agentDependencyGraph['orchestrator'] = new Set(['support-agent', 'search-agent', 'data-analyst']);
  agentDependencyGraph['support-agent'] = new Set(['search-agent']);
  agentDependencyGraph['data-analyst'] = new Set(['search-agent', 'code-assistant']);

  // Seed 30 traces
  for (let i = 0; i < 30; i++) {
    const traceId = 'trace_demo_' + i;
    const agentName = agents[i % agents.length];
    const model = models[i % models.length];
    const sessionId = 'session_demo_' + Math.floor(i / 3);
    const userId = 'user_demo_' + (i % 8);
    const startTime = new Date(now - (24 - i * 0.8) * 3600000);
    const shouldFail = i % 7 === 0;
    const shouldLoop = i % 11 === 0;
    const workflowId = i < 4 ? wfId : null;

    const spans = [];
    spans.push({ trace_id: traceId, span_id: traceId + '_0', agent_name: agentName, session_id: sessionId, user_id: userId, workflow_id: workflowId, step_type: 'agent_start', timestamp: startTime.toISOString(), latency_ms: 50 });

    const pTokens = 800 + Math.floor(Math.random() * 400);
    const cTokens = 200 + Math.floor(Math.random() * 300);
    spans.push({ trace_id: traceId, span_id: traceId + '_1', agent_name: agentName, session_id: sessionId, user_id: userId, workflow_id: workflowId, step_type: 'llm_call', model, prompt_tokens: pTokens, completion_tokens: cTokens, timestamp: new Date(startTime.getTime() + 500).toISOString(), latency_ms: 800 + Math.floor(Math.random() * 1500) });

    const toolCount = shouldLoop ? 6 : (1 + Math.floor(Math.random() * 3));
    for (let t = 0; t < toolCount; t++) {
      const toolName = tools[Math.floor(Math.random() * tools.length)];
      spans.push({ trace_id: traceId, span_id: traceId + '_tool_' + t, agent_name: agentName, session_id: sessionId, user_id: userId, workflow_id: workflowId, step_type: 'tool_call', tool_name: shouldLoop ? 'search_web' : toolName, tool_input: { query: 'demo query ' + t }, tool_output: shouldFail && t === toolCount - 1 ? 'Error 500: Internal server error' : { result: 'ok' }, timestamp: new Date(startTime.getTime() + 1500 + t * 600).toISOString(), latency_ms: 200 + Math.floor(Math.random() * 800), error: shouldFail && t === toolCount - 1 ? 'Tool execution failed' : null, retry_count: shouldFail && t === toolCount - 1 ? 3 : 0 });
    }

    const totalMs = 2000 + toolCount * 600;
    spans.push({ trace_id: traceId, span_id: traceId + '_end', agent_name: agentName, session_id: sessionId, user_id: userId, workflow_id: workflowId, step_type: 'agent_complete', timestamp: new Date(startTime.getTime() + totalMs).toISOString(), latency_ms: 100, error: shouldFail ? 'Agent failed to complete task' : null });

    // Ingest
    spans.forEach(span => {
      const enriched = { ...span, id: genId(), received_at: new Date().toISOString() };
      agentSpans.push(enriched);
      if (!agentTraces.has(traceId)) {
        agentTraces.set(traceId, { trace_id: traceId, agent_name: agentName, workflow_id: workflowId, parent_trace_id: null, session_id: sessionId, user_id: userId, started_at: startTime.toISOString(), ended_at: null, status: 'running', spans: [], total_tokens: 0, total_cost_usd: 0, total_latency_ms: 0, error_count: 0, tool_calls: 0, llm_calls: 0, checkpoints: [], retry_count: 0, fallback_used: false });
      }
      const trace = agentTraces.get(traceId);
      trace.spans.push(enriched);
      trace.ended_at = span.timestamp;
      if (span.latency_ms) trace.total_latency_ms += span.latency_ms;
      if (span.prompt_tokens || span.completion_tokens) { trace.total_tokens += (span.prompt_tokens || 0) + (span.completion_tokens || 0); trace.total_cost_usd += estimateCost(span.model, span.prompt_tokens || 0, span.completion_tokens || 0); }
      if (span.step_type === 'error' || span.error) trace.error_count++;
      if (span.step_type === 'tool_call') trace.tool_calls++;
      if (span.step_type === 'llm_call') trace.llm_calls++;
      if (span.step_type === 'agent_complete') trace.status = span.error ? 'failed' : 'completed';
      if (span.step_type !== 'agent_start') {
        const cp = { checkpoint_id: genId(), span_id: span.span_id, step_type: span.step_type, timestamp: span.timestamp, state_snapshot: { tool_name: span.tool_name || null, tool_input: span.tool_input || null, tool_output: span.tool_output || null, model: span.model || null, error: span.error || null, latency_ms: span.latency_ms || null } };
        trace.checkpoints.push(cp);
        if (!checkpoints.has(traceId)) checkpoints.set(traceId, []);
        checkpoints.get(traceId).push(cp);
      }
      if (workflowId) updateWorkflow(span, trace);
      updateCircuitBreaker(agentName, span);
      updateErrorBudget(agentName, trace, span);
      detectFailures(trace, enriched);
    });
  }

  // Seed web events
  const webTypes = ['page_view', 'click', 'page_view', 'click', 'add_to_cart', 'page_view'];
  for (let i = 0; i < 50; i++) {
    webEvents.push({ id: genId(), event: webTypes[i % webTypes.length], timestamp: new Date(now - (24 - i * 0.48) * 3600000).toISOString(), user_id: 'user_demo_' + (i % 8), session_id: 'session_demo_' + Math.floor(i / 5), received_at: new Date().toISOString(), properties: { path: ['/', '/products', '/cart', '/checkout'][i % 4], selector: ['button.add-to-cart', 'a.nav-link', '#checkout-btn'][i % 3], text: ['Add to Cart', 'Shop Now', 'Checkout'][i % 3] } });
  }

  console.log(`✅ Seeded: ${agentTraces.size} traces, ${agentSpans.length} spans, ${agentIncidents.length} incidents, ${workflows.size} workflows`);
  console.log(`   Circuit breakers: ${circuitBreakers.size}, Error budgets: ${errorBudgets.size}, DLQ: ${deadLetterQueue.length}`);
}

// ============================================================
// CONTACT
// ============================================================
app.post('/api/contact', async (req, res) => {
  const { name, org, email, message } = req.body;
  console.log('Contact form submission:', { name, org, email, messageLength: message?.length });
  console.log('RESEND_API_KEY prefix:', process.env.RESEND_API_KEY?.slice(0, 6), 'length:', process.env.RESEND_API_KEY?.length);
  if (!name || !email || !message) return res.status(400).json({ error: 'Missing required fields' });
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Sentinel.AI <onboarding@resend.dev>',
        to: 'sumedhakhatter482@gmail.com',
        subject: `Sentinel.AI — Message from ${name}${org ? ` (${org})` : ''}`,
        text: `Name: ${name}\nOrg: ${org || '—'}\nEmail: ${email}\n\n${message}`,
      }),
    });
    const result = await response.json();
    console.log('Resend result:', JSON.stringify(result));
    if (!response.ok) throw new Error(result.message || 'Resend API error');
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact email error:', err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 Sentinel.AI — http://localhost:${PORT}`);
  console.log(`   Workflows:       /api/workflows`);
  console.log(`   Circuit Breakers:/api/agent/circuit-breakers`);
  console.log(`   Error Budgets:   /api/agent/error-budgets`);
  console.log(`   Blast Radius:    /api/agent/blast-radius/:agent`);
  console.log(`   Replay:          /api/agent/traces/:id/replay`);
  console.log(`   DLQ:             /api/agent/dlq\n`);
  seedDemoData();
});
