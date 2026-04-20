import type { NextFunction, Request, Response } from "express";
import { performance } from "node:perf_hooks";
import { resolveModelFamily } from "../models.js";
import { subscribeToLogs, type LogEntry } from "../logger.js";

type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue>;

const DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
  300000, 900000, 1800000,
];
const SIZE_BUCKETS_BYTES = [
  64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216,
];
const TEXT_BUCKETS_CHARS = [
  32, 128, 512, 2048, 8192, 32768, 131072, 524288, 2097152,
];
const QUEUE_DEPTH_BUCKETS = [0, 1, 2, 3, 4, 5, 10];

export interface RuntimeMetricsSnapshot {
  activeRequests: number;
  queuedRequests: number;
  queuedConversations: number;
  oldestQueueWaitMs: number;
  responseConversationEntries: number;
  activeSubprocesses: number;
  activeSessions: number;
  sessionFailureStats: {
    totalFailures: number;
    sessionsWithFailures: number;
  };
  store: {
    conversations: number;
    messages: number;
    metrics: number;
  } | null;
  pool: {
    warmedAt: string | null;
    isWarm: boolean;
    poolSize: number;
    warming: boolean;
  } | null;
  modelAvailability: {
    available: number;
    unavailable: number;
    consecutiveAuthFailures: number;
    lastCheckedAt?: string;
  } | null;
}

interface SnapshotSample {
  labels: Labels;
  value: number;
}

interface HistogramSnapshotSample {
  labels: Labels;
  buckets: Array<{ le: number | "+Inf"; value: number }>;
  count: number;
  sum: number;
}

export interface MetricSnapshot {
  type: "counter" | "gauge" | "histogram";
  name: string;
  help: string;
  samples: SnapshotSample[] | HistogramSnapshotSample[];
}

interface ProxyRequestContext {
  createdAt: number;
  stream: string;
  agent: string;
  modelFamily: string;
  reasoningMode: string;
}

function normalizeLabelValue(value: LabelValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function serializeLabels(labels: Labels, expected: string[]): string {
  return expected
    .map((name) => `${name}=${normalizeLabelValue(labels[name])}`)
    .join("|");
}

function renderLabels(labels: Labels, expected: string[]): string {
  if (expected.length === 0) return "";
  const parts = expected.map(
    (name) => `${name}="${escapeLabelValue(normalizeLabelValue(labels[name]))}"`,
  );
  return `{${parts.join(",")}}`;
}

abstract class BaseMetric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge" | "histogram",
    readonly labelNames: string[] = [],
  ) {}

  protected key(labels: Labels): string {
    return serializeLabels(labels, this.labelNames);
  }

  protected cloneLabels(labels: Labels): Labels {
    const cloned: Labels = {};
    for (const name of this.labelNames) {
      cloned[name] = normalizeLabelValue(labels[name]);
    }
    return cloned;
  }
}

class CounterMetric extends BaseMetric {
  private samples = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string, labelNames: string[] = []) {
    super(name, help, "counter", labelNames);
  }

  inc(labels: Labels = {}, value = 1): void {
    const key = this.key(labels);
    const existing = this.samples.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.samples.set(key, {
      labels: this.cloneLabels(labels),
      value,
    });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const sample of this.samples.values()) {
      lines.push(
        `${this.name}${renderLabels(sample.labels, this.labelNames)} ${sample.value}`,
      );
    }
    return lines;
  }

  snapshot(): MetricSnapshot {
    return {
      type: "counter",
      name: this.name,
      help: this.help,
      samples: Array.from(this.samples.values()).map((sample) => ({
        labels: sample.labels,
        value: sample.value,
      })),
    };
  }
}

class GaugeMetric extends BaseMetric {
  private samples = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string, labelNames: string[] = []) {
    super(name, help, "gauge", labelNames);
  }

  set(labels: Labels = {}, value: number): void {
    this.samples.set(this.key(labels), {
      labels: this.cloneLabels(labels),
      value,
    });
  }

  inc(labels: Labels = {}, value = 1): void {
    const key = this.key(labels);
    const existing = this.samples.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.samples.set(key, {
      labels: this.cloneLabels(labels),
      value,
    });
  }

  dec(labels: Labels = {}, value = 1): void {
    this.inc(labels, -value);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const sample of this.samples.values()) {
      lines.push(
        `${this.name}${renderLabels(sample.labels, this.labelNames)} ${sample.value}`,
      );
    }
    return lines;
  }

  snapshot(): MetricSnapshot {
    return {
      type: "gauge",
      name: this.name,
      help: this.help,
      samples: Array.from(this.samples.values()).map((sample) => ({
        labels: sample.labels,
        value: sample.value,
      })),
    };
  }
}

class HistogramMetric extends BaseMetric {
  private samples = new Map<
    string,
    {
      labels: Labels;
      counts: number[];
      count: number;
      sum: number;
    }
  >();

  constructor(
    name: string,
    help: string,
    private readonly buckets: number[],
    labelNames: string[] = [],
  ) {
    super(name, help, "histogram", labelNames);
  }

  observe(labels: Labels = {}, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = this.key(labels);
    const existing =
      this.samples.get(key) ||
      (() => {
        const created = {
          labels: this.cloneLabels(labels),
          counts: new Array(this.buckets.length).fill(0),
          count: 0,
          sum: 0,
        };
        this.samples.set(key, created);
        return created;
      })();

    existing.count += 1;
    existing.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        existing.counts[i] += 1;
      }
    }
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const sample of this.samples.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${renderLabels(
            { ...sample.labels, le: this.buckets[i] },
            [...this.labelNames, "le"],
          )} ${sample.counts[i]}`,
        );
      }
      lines.push(
        `${this.name}_bucket${renderLabels(
          { ...sample.labels, le: "+Inf" },
          [...this.labelNames, "le"],
        )} ${sample.count}`,
      );
      lines.push(
        `${this.name}_sum${renderLabels(sample.labels, this.labelNames)} ${sample.sum}`,
      );
      lines.push(
        `${this.name}_count${renderLabels(sample.labels, this.labelNames)} ${sample.count}`,
      );
    }
    return lines;
  }

  snapshot(): MetricSnapshot {
    return {
      type: "histogram",
      name: this.name,
      help: this.help,
      samples: Array.from(this.samples.values()).map((sample) => ({
        labels: sample.labels,
        buckets: [
          ...this.buckets.map((bucket, index) => ({
            le: bucket,
            value: sample.counts[index],
          })),
          { le: "+Inf" as const, value: sample.count },
        ],
        count: sample.count,
        sum: sample.sum,
      })),
    };
  }
}

function asString(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asBooleanLabel(value: unknown): string {
  return value === true ? "true" : "false";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function classifyErrorKind(reason: unknown): string {
  const message = asString(reason, "").toLowerCase();
  if (!message) return "unknown";
  if (/auth|401|credential|oauth/.test(message)) return "auth";
  if (/model/.test(message)) return "model";
  if (/stall|timed out|timeout/.test(message)) return "timeout";
  if (/queue/.test(message)) return "queue";
  if (/cancel|supersed|disconnect/.test(message)) return "cancel";
  return "server";
}

function normalizeReasonLabel(reason: unknown): string {
  const message = asString(reason, "").toLowerCase();
  if (!message) return "unknown";
  if (message.includes("client_disconnected")) return "client_disconnected";
  if (message.includes("request_superseded") || message.includes("supersed")) {
    return "superseded";
  }
  if (message.includes("auth")) return "auth";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("stall")) return "stall";
  if (message.includes("cancel")) return "cancelled";
  if (message.includes("queue")) return "queue";
  return "other";
}

function modelFamilyLabel(model: unknown): string {
  const modelName = asString(model, "");
  const family = modelName ? resolveModelFamily(modelName) : null;
  return family ?? "unknown";
}

function routeLabel(req: Request): string {
  const routePath =
    req.route && typeof req.route.path === "string" ? req.route.path : null;
  if (routePath) {
    return `${req.baseUrl || ""}${routePath}` || routePath;
  }
  if (req.path === "/metrics" || req.path === "/health") {
    return req.path;
  }
  return "unmatched";
}

function chunkLength(
  chunk: unknown,
  encoding?: BufferEncoding | null,
): number {
  if (chunk == null) return 0;
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, encoding || "utf8");
  }
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  return Buffer.byteLength(String(chunk));
}

function pushGauge(
  lines: string[],
  name: string,
  help: string,
  value: number,
  labels: Labels = {},
): void {
  const labelNames = Object.keys(labels);
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  lines.push(`${name}${renderLabels(labels, labelNames)} ${value}`);
}

function pushCounter(
  lines: string[],
  name: string,
  help: string,
  value: number,
  labels: Labels = {},
): void {
  const labelNames = Object.keys(labels);
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  lines.push(`${name}${renderLabels(labels, labelNames)} ${value}`);
}

export class ProxyMetricsCollector {
  private readonly metrics = {
    httpRequestsInFlight: new GaugeMetric(
      "claude_proxy_http_requests_in_flight",
      "Current in-flight HTTP requests.",
    ),
    httpRequestsTotal: new CounterMetric(
      "claude_proxy_http_requests_total",
      "Completed HTTP requests by method, route, and status.",
      ["method", "route", "status", "status_class", "ended"],
    ),
    httpRequestDurationMs: new HistogramMetric(
      "claude_proxy_http_request_duration_ms",
      "End-to-end HTTP request duration in milliseconds.",
      DURATION_BUCKETS_MS,
      ["method", "route", "status_class", "ended"],
    ),
    httpResponseBytes: new HistogramMetric(
      "claude_proxy_http_response_bytes",
      "HTTP response size in bytes.",
      SIZE_BUCKETS_BYTES,
      ["method", "route", "status_class", "ended"],
    ),
    proxyRequestsStartedTotal: new CounterMetric(
      "claude_proxy_requests_started_total",
      "Proxy request starts by stream mode, agent, model family, and reasoning mode.",
      ["stream", "agent", "model_family", "reasoning_mode"],
    ),
    proxyRequestOutcomesTotal: new CounterMetric(
      "claude_proxy_request_outcomes_total",
      "Final proxy request outcomes.",
      ["outcome", "stream", "agent", "model_family", "reasoning_mode"],
    ),
    proxyRequestErrorsTotal: new CounterMetric(
      "claude_proxy_request_errors_total",
      "Proxy request error events before or after retries.",
      ["kind", "stream", "agent", "model_family", "reasoning_mode"],
    ),
    proxyRequestRetriesTotal: new CounterMetric(
      "claude_proxy_request_retries_total",
      "Proxy request retries.",
      ["reason", "stream", "model_family"],
    ),
    proxyRequestDurationMs: new HistogramMetric(
      "claude_proxy_request_duration_ms",
      "Final proxy request duration in milliseconds.",
      DURATION_BUCKETS_MS,
      ["outcome", "stream", "model_family"],
    ),
    proxyRequestTtfbMs: new HistogramMetric(
      "claude_proxy_request_ttfb_ms",
      "Proxy request time to first byte in milliseconds.",
      DURATION_BUCKETS_MS,
      ["stream", "model_family"],
    ),
    proxyRequestSpawnToFirstTokenMs: new HistogramMetric(
      "claude_proxy_request_spawn_to_first_token_ms",
      "Latency between subprocess spawn and first token in milliseconds.",
      DURATION_BUCKETS_MS,
      ["stream", "model_family"],
    ),
    proxyRequestResponseChars: new HistogramMetric(
      "claude_proxy_request_response_chars",
      "Assistant response length in UTF-16 characters.",
      TEXT_BUCKETS_CHARS,
      ["stream", "model_family"],
    ),
    proxyRequestQueueDepth: new HistogramMetric(
      "claude_proxy_request_queue_depth",
      "Queue depth seen when a proxy request starts.",
      QUEUE_DEPTH_BUCKETS,
      ["stream"],
    ),
    queueEventsTotal: new CounterMetric(
      "claude_proxy_queue_events_total",
      "Queue events emitted by the proxy.",
      ["event"],
    ),
    queueDepthOnEnqueue: new HistogramMetric(
      "claude_proxy_queue_depth_on_enqueue",
      "Queue depth at enqueue time.",
      QUEUE_DEPTH_BUCKETS,
    ),
    subprocessSpawnsTotal: new CounterMetric(
      "claude_proxy_subprocess_spawns_total",
      "Claude subprocess spawns.",
      ["model_family", "reasoning_mode", "thinking"],
    ),
    subprocessKillsTotal: new CounterMetric(
      "claude_proxy_subprocess_kills_total",
      "Claude subprocess kill signals.",
      ["signal", "reason"],
    ),
    subprocessStallsTotal: new CounterMetric(
      "claude_proxy_subprocess_stalls_total",
      "Detected stalled Claude subprocesses.",
      ["model_family"],
    ),
    subprocessCloseTotal: new CounterMetric(
      "claude_proxy_subprocess_close_total",
      "Claude subprocess close events by exit code.",
      ["code"],
    ),
    sessionEventsTotal: new CounterMetric(
      "claude_proxy_session_events_total",
      "Session lifecycle events.",
      ["event"],
    ),
    authEventsTotal: new CounterMetric(
      "claude_proxy_auth_events_total",
      "Authentication-related proxy events.",
      ["event", "phase"],
    ),
    poolEventsTotal: new CounterMetric(
      "claude_proxy_pool_events_total",
      "Warm-pool events.",
      ["event"],
    ),
    cliErrorsTotal: new CounterMetric(
      "claude_proxy_cli_errors_total",
      "Claude CLI classified error events.",
      ["status", "code"],
    ),
    tokenValidationFailuresTotal: new CounterMetric(
      "claude_proxy_token_validation_failures_total",
      "Token validation fallback events.",
      ["reason"],
    ),
  } as const;

  private readonly requestContexts = new Map<string, ProxyRequestContext>();
  private readonly unsub?: () => void;
  private readonly startedAt = Date.now();

  constructor(options: { subscribe?: boolean } = {}) {
    if (options.subscribe) {
      this.unsub = subscribeToLogs((entry) => {
        this.recordLog(entry);
      });
    }
  }

  dispose(): void {
    this.unsub?.();
  }

  private getContext(requestId: unknown): ProxyRequestContext | undefined {
    return typeof requestId === "string"
      ? this.requestContexts.get(requestId)
      : undefined;
  }

  private labelsFromContext(context?: ProxyRequestContext): Labels {
    return {
      stream: context?.stream ?? "unknown",
      agent: context?.agent ?? "none",
      model_family: context?.modelFamily ?? "unknown",
      reasoning_mode: context?.reasoningMode ?? "unknown",
    };
  }

  private pruneContexts(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [requestId, context] of this.requestContexts) {
      if (context.createdAt < cutoff) {
        this.requestContexts.delete(requestId);
      }
    }
  }

  recordHttpRequest(params: {
    method: string;
    route: string;
    status: number;
    durationMs: number;
    responseBytes: number;
    ended: "finish" | "close";
  }): void {
    const statusClass = `${Math.floor(params.status / 100)}xx`;
    const labels = {
      method: params.method,
      route: params.route,
      status: String(params.status),
      status_class: statusClass,
      ended: params.ended,
    };
    this.metrics.httpRequestsTotal.inc(labels);
    this.metrics.httpRequestDurationMs.observe(
      {
        method: params.method,
        route: params.route,
        status_class: statusClass,
        ended: params.ended,
      },
      params.durationMs,
    );
    this.metrics.httpResponseBytes.observe(
      {
        method: params.method,
        route: params.route,
        status_class: statusClass,
        ended: params.ended,
      },
      params.responseBytes,
    );
  }

  middleware = (req: Request, res: Response, next: NextFunction): void => {
    this.metrics.httpRequestsInFlight.inc();
    const startedAt = performance.now();
    let responseBytes = 0;
    let done = false;

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      responseBytes += chunkLength(
        chunk,
        typeof encoding === "string" ? (encoding as BufferEncoding) : null,
      );
      return originalWrite(
        chunk as never,
        encoding as never,
        cb as never,
      );
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      responseBytes += chunkLength(
        chunk,
        typeof encoding === "string" ? (encoding as BufferEncoding) : null,
      );
      return originalEnd(
        chunk as never,
        encoding as never,
        cb as never,
      );
    }) as typeof res.end;

    const finalize = (ended: "finish" | "close"): void => {
      if (done) return;
      done = true;
      this.metrics.httpRequestsInFlight.dec();
      const finished = ended === "finish";
      const durationMs = performance.now() - startedAt;
      const status = finished ? res.statusCode : 499;
      this.recordHttpRequest({
        method: req.method,
        route: routeLabel(req),
        status,
        durationMs,
        responseBytes,
        ended,
      });
    };

    res.once("finish", () => finalize("finish"));
    res.once("close", () => finalize("close"));
    next();
  };

  recordLog(entry: LogEntry): void {
    this.pruneContexts();

    switch (entry.event) {
      case "request.start": {
        const ttfbMs = asNumber(entry.ttfbMs);
        if (ttfbMs !== undefined) {
          const context = this.getContext(entry.requestId);
          const labels = this.labelsFromContext(context);
          this.metrics.proxyRequestTtfbMs.observe(
            {
              stream: labels.stream,
              model_family: labels.model_family,
            },
            ttfbMs,
          );
          const firstTokenMs = asNumber(entry.firstTokenMs);
          if (firstTokenMs !== undefined) {
            this.metrics.proxyRequestSpawnToFirstTokenMs.observe(
              {
                stream: labels.stream,
                model_family: labels.model_family,
              },
              firstTokenMs,
            );
          }
          return;
        }

        if (!entry.requestId) return;
        const context: ProxyRequestContext = {
          createdAt: Date.now(),
          stream: asBooleanLabel(entry.stream),
          agent: asString(entry.agent, "none"),
          modelFamily: modelFamilyLabel(entry.model),
          reasoningMode: asString(entry.reasoningMode, "off"),
        };
        this.requestContexts.set(entry.requestId, context);
        this.metrics.proxyRequestsStartedTotal.inc(this.labelsFromContext(context));
        const queueDepth = asNumber(entry.queueDepth);
        if (queueDepth !== undefined) {
          this.metrics.proxyRequestQueueDepth.observe(
            { stream: context.stream },
            queueDepth,
          );
        }
        return;
      }

      case "request.complete": {
        const context = this.getContext(entry.requestId);
        const labels = this.labelsFromContext(context);
        this.metrics.proxyRequestOutcomesTotal.inc({
          ...labels,
          outcome: "success",
        });
        const durationMs = asNumber(entry.durationMs);
        if (durationMs !== undefined) {
          this.metrics.proxyRequestDurationMs.observe(
            {
              outcome: "success",
              stream: labels.stream,
              model_family: labels.model_family,
            },
            durationMs,
          );
        }
        const responseLength = asNumber(entry.responseLength);
        if (responseLength !== undefined) {
          this.metrics.proxyRequestResponseChars.observe(
            {
              stream: labels.stream,
              model_family: labels.model_family,
            },
            responseLength,
          );
        }
        if (entry.requestId) {
          this.requestContexts.delete(entry.requestId);
        }
        return;
      }

      case "request.cancel": {
        const context = this.getContext(entry.requestId);
        const labels = this.labelsFromContext(context);
        this.metrics.proxyRequestOutcomesTotal.inc({
          ...labels,
          outcome: "cancelled",
        });
        if (entry.requestId) {
          this.requestContexts.delete(entry.requestId);
        }
        return;
      }

      case "request.timeout": {
        const context = this.getContext(entry.requestId);
        const labels = this.labelsFromContext(context);
        this.metrics.proxyRequestOutcomesTotal.inc({
          ...labels,
          outcome: "timeout",
        });
        const durationMs = asNumber(entry.durationMs);
        if (durationMs !== undefined) {
          this.metrics.proxyRequestDurationMs.observe(
            {
              outcome: "timeout",
              stream: labels.stream,
              model_family: labels.model_family,
            },
            durationMs,
          );
        }
        if (entry.requestId) {
          this.requestContexts.delete(entry.requestId);
        }
        return;
      }

      case "request.error": {
        const context = this.getContext(entry.requestId);
        const labels = this.labelsFromContext(context);
        this.metrics.proxyRequestErrorsTotal.inc({
          ...labels,
          kind: classifyErrorKind(entry.reason),
        });
        return;
      }

      case "request.retry": {
        const context = this.getContext(entry.requestId);
        const labels = this.labelsFromContext(context);
        this.metrics.proxyRequestRetriesTotal.inc({
          stream: labels.stream,
          model_family: labels.model_family,
          reason: normalizeReasonLabel(entry.reason),
        });
        return;
      }

      case "queue.enqueue": {
        this.metrics.queueEventsTotal.inc({ event: "enqueue" });
        const depth = asNumber(entry.depth);
        if (depth !== undefined) {
          this.metrics.queueDepthOnEnqueue.observe({}, depth);
        }
        return;
      }

      case "queue.drop":
      case "queue.blocked":
      case "queue.timeout": {
        const queueEvent = entry.event.replace("queue.", "");
        this.metrics.queueEventsTotal.inc({ event: queueEvent });
        return;
      }

      case "subprocess.spawn": {
        this.metrics.subprocessSpawnsTotal.inc({
          model_family: modelFamilyLabel(entry.model),
          reasoning_mode: asString(entry.reasoningMode, "off"),
          thinking: asString(entry.thinking, "off"),
        });
        return;
      }

      case "subprocess.kill": {
        this.metrics.subprocessKillsTotal.inc({
          signal: asString(entry.signal, "unknown"),
          reason: normalizeReasonLabel(entry.reason),
        });
        return;
      }

      case "subprocess.stall": {
        this.metrics.subprocessStallsTotal.inc({
          model_family: modelFamilyLabel(entry.model),
        });
        return;
      }

      case "subprocess.close": {
        this.metrics.subprocessCloseTotal.inc({
          code: String(entry.code ?? "null"),
        });
        return;
      }

      case "session.created":
      case "session.resume_fail":
      case "session.invalidate": {
        const sessionEvent = entry.event.replace("session.", "");
        this.metrics.sessionEventsTotal.inc({ event: sessionEvent });
        return;
      }

      case "auth.failure":
      case "auth.recovered":
      case "auth.proactive_refresh": {
        const authEvent = entry.event.replace("auth.", "");
        this.metrics.authEventsTotal.inc({
          event: authEvent,
          phase: asString(entry.phase, "none"),
        });
        return;
      }

      case "pool.warmed":
      case "pool.warm_failed": {
        const poolEvent = entry.event.replace("pool.", "");
        this.metrics.poolEventsTotal.inc({ event: poolEvent });
        return;
      }

      case "cli.error": {
        this.metrics.cliErrorsTotal.inc({
          status: String(entry.classifiedStatus ?? "unknown"),
          code: asString(entry.classifiedCode, "unknown"),
        });
        return;
      }

      case "token.validation_failed": {
        this.metrics.tokenValidationFailuresTotal.inc({
          reason: normalizeReasonLabel(entry.reason),
        });
        return;
      }

      default:
        return;
    }
  }

  renderPrometheus(runtime: RuntimeMetricsSnapshot): string {
    const lines: string[] = [];
    for (const metric of Object.values(this.metrics)) {
      lines.push(...metric.render());
    }

    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();

    pushGauge(
      lines,
      "claude_proxy_process_uptime_seconds",
      "Node.js process uptime in seconds.",
      process.uptime(),
    );
    pushGauge(
      lines,
      "claude_proxy_process_resident_memory_bytes",
      "Node.js process resident memory in bytes.",
      memory.rss,
    );
    pushGauge(
      lines,
      "claude_proxy_process_heap_used_bytes",
      "Node.js heap used in bytes.",
      memory.heapUsed,
    );
    pushGauge(
      lines,
      "claude_proxy_process_heap_total_bytes",
      "Node.js heap total in bytes.",
      memory.heapTotal,
    );
    pushGauge(
      lines,
      "claude_proxy_process_external_memory_bytes",
      "Node.js external memory in bytes.",
      memory.external,
    );
    pushCounter(
      lines,
      "claude_proxy_process_cpu_user_seconds_total",
      "Node.js CPU user time in seconds.",
      cpu.user / 1_000_000,
    );
    pushCounter(
      lines,
      "claude_proxy_process_cpu_system_seconds_total",
      "Node.js CPU system time in seconds.",
      cpu.system / 1_000_000,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_active_requests",
      "Current active proxy requests keyed by conversation.",
      runtime.activeRequests,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_queued_requests",
      "Current queued requests across all conversations.",
      runtime.queuedRequests,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_queued_conversations",
      "Current conversations with queue state.",
      runtime.queuedConversations,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_oldest_queue_wait_ms",
      "Oldest queued request wait time in milliseconds.",
      runtime.oldestQueueWaitMs,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_response_conversation_entries",
      "Current in-memory previous_response_id mappings.",
      runtime.responseConversationEntries,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_active_subprocesses",
      "Current active Claude subprocesses.",
      runtime.activeSubprocesses,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_active_sessions",
      "Current active Claude session mappings.",
      runtime.activeSessions,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_session_resume_failures",
      "Current aggregate session resume failure count.",
      runtime.sessionFailureStats.totalFailures,
    );
    pushGauge(
      lines,
      "claude_proxy_runtime_sessions_with_failures",
      "Current sessions that have non-zero resume failures.",
      runtime.sessionFailureStats.sessionsWithFailures,
    );

    if (runtime.store) {
      pushGauge(
        lines,
        "claude_proxy_store_conversations",
        "Stored conversations in SQLite.",
        runtime.store.conversations,
      );
      pushGauge(
        lines,
        "claude_proxy_store_messages",
        "Stored messages in SQLite.",
        runtime.store.messages,
      );
      pushGauge(
        lines,
        "claude_proxy_store_metrics",
        "Stored metric rows in SQLite.",
        runtime.store.metrics,
      );
    }

    if (runtime.pool) {
      pushGauge(
        lines,
        "claude_proxy_pool_is_warm",
        "Whether the warm pool is currently considered warm.",
        runtime.pool.isWarm ? 1 : 0,
      );
      pushGauge(
        lines,
        "claude_proxy_pool_warming",
        "Whether the warm pool is currently warming.",
        runtime.pool.warming ? 1 : 0,
      );
      pushGauge(
        lines,
        "claude_proxy_pool_size",
        "Configured warm pool size.",
        runtime.pool.poolSize,
      );
      if (runtime.pool.warmedAt) {
        pushGauge(
          lines,
          "claude_proxy_pool_last_warmed_timestamp_seconds",
          "Unix timestamp of the last successful warm cycle.",
          Date.parse(runtime.pool.warmedAt) / 1000,
        );
      }
    }

    if (runtime.modelAvailability) {
      pushGauge(
        lines,
        "claude_proxy_models_available",
        "Count of currently available Claude models.",
        runtime.modelAvailability.available,
      );
      pushGauge(
        lines,
        "claude_proxy_models_unavailable",
        "Count of currently unavailable Claude models.",
        runtime.modelAvailability.unavailable,
      );
      pushGauge(
        lines,
        "claude_proxy_consecutive_auth_failures",
        "Current consecutive auth failures in model availability checks.",
        runtime.modelAvailability.consecutiveAuthFailures,
      );
      if (runtime.modelAvailability.lastCheckedAt) {
        pushGauge(
          lines,
          "claude_proxy_model_availability_checked_timestamp_seconds",
          "Unix timestamp of the last model availability probe snapshot.",
          Date.parse(runtime.modelAvailability.lastCheckedAt) / 1000,
        );
      }
    }

    pushGauge(
      lines,
      "claude_proxy_process_start_timestamp_seconds",
      "Unix timestamp when the metrics collector started.",
      this.startedAt / 1000,
    );

    return `${lines.join("\n")}\n`;
  }

  getJsonSnapshot(runtime: RuntimeMetricsSnapshot): {
    generatedAt: string;
    process: {
      startedAt: string;
      uptimeSeconds: number;
      memoryBytes: {
        rss: number;
        heapUsed: number;
        heapTotal: number;
        external: number;
      };
      cpuSeconds: {
        user: number;
        system: number;
      };
    };
    runtime: RuntimeMetricsSnapshot;
    metrics: MetricSnapshot[];
  } {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();

    return {
      generatedAt: new Date().toISOString(),
      process: {
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSeconds: process.uptime(),
        memoryBytes: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
        },
        cpuSeconds: {
          user: cpu.user / 1_000_000,
          system: cpu.system / 1_000_000,
        },
      },
      runtime,
      metrics: Object.values(this.metrics).map((metric) => metric.snapshot()),
    };
  }
}

export const proxyMetrics = new ProxyMetricsCollector({ subscribe: true });

export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  proxyMetrics.middleware(req, res, next);
}
