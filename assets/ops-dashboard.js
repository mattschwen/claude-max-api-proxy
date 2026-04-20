const MAX_HISTORY = 180;
const MAX_LOGS = 360;
const DETAIL_LIMIT = 18;
const CHART_WIDTH = 640;
const CHART_HEIGHT = 180;

const state = {
  snapshot: null,
  history: [],
  logs: [],
  selectedConversationId: null,
  conversationDetail: null,
  connected: false,
  lastSnapshotAt: 0,
  followLogs: true,
  logPaused: false,
  eventSource: null,
  detailRequestId: 0,
};

const dom = {
  connectionChip: document.getElementById("connectionChip"),
  connectionLabel: document.getElementById("connectionLabel"),
  routeSummary: document.getElementById("routeSummary"),
  activeSummary: document.getElementById("activeSummary"),
  queueSummary: document.getElementById("queueSummary"),
  errorSummary: document.getElementById("errorSummary"),
  memorySummary: document.getElementById("memorySummary"),
  snapshotAge: document.getElementById("snapshotAge"),
  clockValue: document.getElementById("clockValue"),
  systemMode: document.getElementById("systemMode"),
  providerMode: document.getElementById("providerMode"),
  nodeClients: document.getElementById("nodeClients"),
  nodeClientsValue: document.getElementById("nodeClientsValue"),
  nodeClientsMeta: document.getElementById("nodeClientsMeta"),
  pipeClients: document.getElementById("pipeClients"),
  pipeClientsLabel: document.getElementById("pipeClientsLabel"),
  nodeIngress: document.getElementById("nodeIngress"),
  nodeIngressValue: document.getElementById("nodeIngressValue"),
  nodeIngressMeta: document.getElementById("nodeIngressMeta"),
  pipeIngress: document.getElementById("pipeIngress"),
  pipeIngressLabel: document.getElementById("pipeIngressLabel"),
  nodeQueue: document.getElementById("nodeQueue"),
  nodeQueueValue: document.getElementById("nodeQueueValue"),
  nodeQueueMeta: document.getElementById("nodeQueueMeta"),
  pipeQueue: document.getElementById("pipeQueue"),
  pipeQueueLabel: document.getElementById("pipeQueueLabel"),
  nodeRuntime: document.getElementById("nodeRuntime"),
  nodeRuntimeValue: document.getElementById("nodeRuntimeValue"),
  nodeRuntimeMeta: document.getElementById("nodeRuntimeMeta"),
  pipeRuntime: document.getElementById("pipeRuntime"),
  pipeRuntimeLabel: document.getElementById("pipeRuntimeLabel"),
  nodeProviders: document.getElementById("nodeProviders"),
  nodeProvidersValue: document.getElementById("nodeProvidersValue"),
  nodeProvidersMeta: document.getElementById("nodeProvidersMeta"),
  providerStack: document.getElementById("providerStack"),
  signalSummary: document.getElementById("signalSummary"),
  stateStack: document.getElementById("stateStack"),
  alertSummary: document.getElementById("alertSummary"),
  alertStack: document.getElementById("alertStack"),
  laneSummary: document.getElementById("laneSummary"),
  laneList: document.getElementById("laneList"),
  flowCurrent: document.getElementById("flowCurrent"),
  flowLegend: document.getElementById("flowLegend"),
  flowChart: document.getElementById("flowChart"),
  latencyCurrent: document.getElementById("latencyCurrent"),
  latencyLegend: document.getElementById("latencyLegend"),
  latencyChart: document.getElementById("latencyChart"),
  pressureCurrent: document.getElementById("pressureCurrent"),
  pressureLegend: document.getElementById("pressureLegend"),
  pressureChart: document.getElementById("pressureChart"),
  loadCurrent: document.getElementById("loadCurrent"),
  loadLegend: document.getElementById("loadLegend"),
  loadChart: document.getElementById("loadChart"),
  conversationCounts: document.getElementById("conversationCounts"),
  conversationList: document.getElementById("conversationList"),
  detailTitle: document.getElementById("detailTitle"),
  detailRoute: document.getElementById("detailRoute"),
  detailTimer: document.getElementById("detailTimer"),
  detailMeta: document.getElementById("detailMeta"),
  conversationDetail: document.getElementById("conversationDetail"),
  followLogsButton: document.getElementById("followLogsButton"),
  pauseLogsButton: document.getElementById("pauseLogsButton"),
  logEventFilter: document.getElementById("logEventFilter"),
  logSearch: document.getElementById("logSearch"),
  logStream: document.getElementById("logStream"),
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatCount(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatFloat(value, digits = 1) {
  if (!Number.isFinite(Number(value))) return "0";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatCompact(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: Number(value) < 100 ? 1 : 0,
  }).format(Number(value));
}

function formatMemory(bytes) {
  if (!Number.isFinite(Number(bytes))) return "0 MB";
  const value = Number(bytes);
  if (value < 1024 * 1024) {
    return `${Math.max(1, Math.round(value / 1024))} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${Math.round(value / (1024 * 1024))} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return "0 ms";
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value < 60_000) return `${Math.round(value / 1000)} s`;
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatAge(ms) {
  if (!Number.isFinite(Number(ms))) return "0s";
  const value = Math.max(0, Number(ms));
  if (value < 1000) return "now";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m`;
  return `${Math.floor(value / 3_600_000)}h`;
}

function formatPercent(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return "0%";
  return `${formatFloat(value, digits)}%`;
}

function shortId(value, length = 8) {
  if (!value) return "n/a";
  return String(value).slice(0, length);
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeProviderId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeModelId(value) {
  return String(value || "").trim().toLowerCase();
}

function humanizeProvider(providerId) {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return "Unrouted";
  if (normalized === "claude-cli") return "Claude Code CLI";
  if (normalized === "gemini-cli") return "Gemini CLI";
  if (normalized === "openai-fallback") return "Fallback API";
  return titleCase(normalized.replace(/\./g, " "));
}

function humanizeTransport(transport) {
  if (transport === "local-cli") return "Local CLI";
  if (transport === "openai-compatible") return "HTTP API";
  return titleCase(transport || "route");
}

function humanizeModel(model) {
  const raw = String(model || "").trim();
  if (!raw) return "Unknown model";
  if (raw.startsWith("claude-")) return raw.replace(/^claude-/, "Claude ");
  if (raw.startsWith("gemini-")) return raw.replace(/^gemini-/, "Gemini ");
  return raw;
}

function statusBadgeState(status) {
  if (status === "active") return "active";
  if (status === "queued") return "queued";
  if (status === "ok") return "ok";
  if (status === "warn") return "warn";
  if (status === "alarm") return "alarm";
  return "idle";
}

function setConnected(connected) {
  state.connected = connected;
  document.body.dataset.connected = connected ? "true" : "false";
  dom.connectionChip.dataset.state = connected ? "ok" : "alarm";
  dom.connectionLabel.textContent = connected ? "Link live" : "Retrying";
}

function updateClock() {
  dom.clockValue.textContent = new Date().toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (!state.lastSnapshotAt) {
    dom.snapshotAge.textContent = "waiting";
    return;
  }
  dom.snapshotAge.textContent = formatDuration(Date.now() - state.lastSnapshotAt);
}

function metricByName(snapshot, name) {
  return asArray(snapshot?.metricSnapshot?.metrics).find(
    (metric) => metric?.name === name,
  ) || null;
}

function counterValue(snapshot, name, predicate) {
  const metric = metricByName(snapshot, name);
  if (!metric || !Array.isArray(metric.samples)) return 0;
  return metric.samples.reduce((sum, sample) => {
    const labels = sample?.labels || {};
    if (predicate && !predicate(labels)) return sum;
    return sum + asNumber(sample?.value);
  }, 0);
}

function gaugeValue(snapshot, name, predicate) {
  return counterValue(snapshot, name, predicate);
}

function aggregateHistogram(snapshot, name, predicate) {
  const metric = metricByName(snapshot, name);
  if (
    !metric ||
    metric.type !== "histogram" ||
    !Array.isArray(metric.samples) ||
    metric.samples.length === 0
  ) {
    return null;
  }

  const buckets = asArray(metric.samples[0]?.buckets).map((bucket) => ({
    le: bucket?.le,
    value: 0,
  }));

  let count = 0;
  let sum = 0;

  metric.samples.forEach((sample) => {
    const labels = sample?.labels || {};
    if (predicate && !predicate(labels)) return;
    count += asNumber(sample?.count);
    sum += asNumber(sample?.sum);
    asArray(sample?.buckets).forEach((bucket, index) => {
      if (!buckets[index]) return;
      buckets[index].value += asNumber(bucket?.value);
    });
  });

  return { buckets, count, sum };
}

function histogramQuantile(snapshot, name, quantile, predicate) {
  const aggregate = aggregateHistogram(snapshot, name, predicate);
  if (!aggregate || aggregate.count <= 0) return null;

  const rank = aggregate.count * quantile;
  let previousCount = 0;
  let previousLe = 0;

  for (const bucket of aggregate.buckets) {
    const currentCount = asNumber(bucket.value);
    const le = bucket.le === "+Inf" ? previousLe : asNumber(bucket.le);

    if (rank <= currentCount) {
      const bucketCount = currentCount - previousCount;
      if (bucketCount <= 0) return le;
      const fraction = (rank - previousCount) / bucketCount;
      return previousLe + (le - previousLe) * Math.max(0, Math.min(1, fraction));
    }

    previousCount = currentCount;
    if (bucket.le !== "+Inf") {
      previousLe = asNumber(bucket.le);
    }
  }

  return previousLe;
}

function findRecentLog(conversationId, matcher) {
  if (!conversationId) return null;
  for (let index = state.logs.length - 1; index >= 0; index -= 1) {
    const entry = state.logs[index];
    if (entry?.conversationId !== conversationId) continue;
    if (matcher(entry)) return entry;
  }
  return null;
}

function providerSupportsModel(provider, model) {
  if (!provider || !model) return false;
  const supported = [provider.model, ...(provider.extraModels || [])]
    .map(normalizeModelId)
    .filter(Boolean);
  return supported.includes(normalizeModelId(model));
}

function inferProviderId(params) {
  const explicit = normalizeProviderId(
    params.startLog?.upstreamProvider || params.startLog?.provider,
  );
  if (explicit) {
    return explicit;
  }

  const model = normalizeModelId(params.model);
  const providers = asArray(params.snapshot?.config?.externalProviders);
  const matched = providers.find((provider) => providerSupportsModel(provider, model));
  if (matched) {
    return normalizeProviderId(matched.provider);
  }

  if (model.startsWith("gemini")) return "gemini-cli";
  if (model.startsWith("claude")) return "claude-cli";

  const availableClaude = asArray(params.snapshot?.availability?.available);
  const unavailableClaude = asArray(params.snapshot?.availability?.unavailable);
  const isKnownClaude = availableClaude.some(
    (entry) => normalizeModelId(entry?.id) === model,
  ) || unavailableClaude.some(
    (entry) => normalizeModelId(entry?.id) === model,
  );
  if (isKnownClaude) {
    return "claude-cli";
  }

  return providers.length ? normalizeProviderId(providers[0]?.provider) : "";
}

function buildRouteInfo(params) {
  const providerId = inferProviderId(params);
  const providerName = humanizeProvider(providerId);
  const modelName = humanizeModel(params.model);
  const providers = asArray(params.snapshot?.config?.externalProviders);
  const externalProvider = providers.find(
    (provider) => normalizeProviderId(provider.provider) === providerId,
  );

  const transport = externalProvider
    ? humanizeTransport(externalProvider.transport)
    : "Native CLI";

  return {
    providerId,
    providerName,
    modelName,
    transport,
    summary: providerId
      ? `${providerName} / ${modelName}`
      : modelName,
  };
}

function latestTotals(snapshot) {
  const process = snapshot?.metricSnapshot?.process || {};
  const cpu = process.cpuSeconds || {};
  const memory = process.memoryBytes || {};
  return {
    outcomes: counterValue(snapshot, "claude_proxy_request_outcomes_total"),
    errors: counterValue(snapshot, "claude_proxy_request_errors_total"),
    retries: counterValue(snapshot, "claude_proxy_request_retries_total"),
    stalls: counterValue(snapshot, "claude_proxy_subprocess_stalls_total"),
    cpuUser: asNumber(cpu.user),
    cpuSystem: asNumber(cpu.system),
    rss: asNumber(memory.rss),
    heapUsed: asNumber(memory.heapUsed),
    httpInflight: gaugeValue(snapshot, "claude_proxy_http_requests_in_flight"),
  };
}

function deriveSnapshot(snapshot, previousEntry) {
  const now = Date.parse(snapshot.generatedAt) || Date.now();
  const totals = latestTotals(snapshot);

  let throughput = 0;
  let errorRate = 0;
  let retryRate = 0;
  let cpuPercent = 0;

  if (previousEntry) {
    const elapsedSeconds = Math.max(
      0.001,
      (now - previousEntry.time) / 1000,
    );
    throughput = Math.max(
      0,
      (totals.outcomes - previousEntry.totals.outcomes) / elapsedSeconds,
    );
    errorRate = Math.max(
      0,
      ((totals.errors + totals.stalls) -
        (previousEntry.totals.errors + previousEntry.totals.stalls)) /
        elapsedSeconds *
        60,
    );
    retryRate = Math.max(
      0,
      (totals.retries - previousEntry.totals.retries) / elapsedSeconds * 60,
    );
    cpuPercent = Math.max(
      0,
      ((totals.cpuUser -
        previousEntry.totals.cpuUser +
        totals.cpuSystem -
        previousEntry.totals.cpuSystem) /
        elapsedSeconds) *
        100,
    );
  }

  return {
    time: now,
    snapshot,
    totals,
    derived: {
      throughput,
      errorRate,
      retryRate,
      p50: histogramQuantile(snapshot, "claude_proxy_request_duration_ms", 0.5),
      p95: histogramQuantile(snapshot, "claude_proxy_request_duration_ms", 0.95),
      ttfb95: histogramQuantile(snapshot, "claude_proxy_request_ttfb_ms", 0.95),
      activeRequests: asNumber(snapshot?.runtime?.activeRequests),
      queuedRequests: asNumber(snapshot?.runtime?.queuedRequests),
      activeSessions: asNumber(snapshot?.runtime?.activeSessions),
      activeSubprocesses: asNumber(snapshot?.runtime?.activeSubprocesses),
      cpuPercent,
      rss: totals.rss,
      heapUsed: totals.heapUsed,
      httpInflight: totals.httpInflight,
    },
  };
}

function pushHistory(snapshot) {
  const previousEntry = state.history[state.history.length - 1] || null;
  const nextEntry = deriveSnapshot(snapshot, previousEntry);
  if (previousEntry && previousEntry.time === nextEntry.time) {
    state.history[state.history.length - 1] = nextEntry;
  } else {
    state.history.push(nextEntry);
  }
  if (state.history.length > MAX_HISTORY) {
    state.history.splice(0, state.history.length - MAX_HISTORY);
  }
}

function collectProviderStats(snapshot) {
  const recentConversations = asArray(snapshot?.recentConversations);
  const activeIds = new Set(
    asArray(snapshot?.queue?.activeRequests).map((entry) => entry.conversationId),
  );
  const queueStates = new Map(
    asArray(snapshot?.queue?.conversations).map((entry) => [
      entry.conversationId,
      entry,
    ]),
  );

  const counts = new Map();
  recentConversations.forEach((conversation) => {
    const startLog = findRecentLog(
      conversation.conversationId,
      (entry) => entry.event === "request.start",
    );
    const route = buildRouteInfo({
      snapshot,
      model: conversation.model,
      startLog,
    });
    const key = route.providerId || "unrouted";
    if (!counts.has(key)) {
      counts.set(key, { recent: 0, active: 0, queued: 0 });
    }
    const bucket = counts.get(key);
    bucket.recent += 1;
    if (activeIds.has(conversation.conversationId)) {
      bucket.active += 1;
    } else if ((queueStates.get(conversation.conversationId)?.queued || 0) > 0) {
      bucket.queued += 1;
    }
  });
  return counts;
}

function buildProviderRows(snapshot) {
  const rows = [];
  const availability = snapshot?.availability || {};
  const providerStats = collectProviderStats(snapshot);
  const availableClaude = asArray(availability.available);
  const unavailableClaude = asArray(availability.unavailable);
  const claudeLoggedIn = availability?.auth?.loggedIn !== false;
  const externalProviders = asArray(snapshot?.config?.externalProviders);

  const claudeTraffic = providerStats.get("claude-cli") || {
    recent: 0,
    active: 0,
    queued: 0,
  };

  let claudeState = "";
  if (!claudeLoggedIn || snapshot?.status === "unhealthy") {
    claudeState = "alarm";
  } else if (availableClaude.length > 0) {
    claudeState = "ok";
  } else if (unavailableClaude.length > 0) {
    claudeState = externalProviders.length ? "warn" : "alarm";
  } else {
    claudeState = externalProviders.length ? "warn" : "";
  }

  rows.push({
    state: claudeState,
    label: "Primary",
    name: "Claude Code CLI",
    detail: availableClaude.length
      ? `${availableClaude.length} model${availableClaude.length === 1 ? "" : "s"} ready`
      : unavailableClaude.length
        ? `${unavailableClaude.length} model probe${unavailableClaude.length === 1 ? "" : "s"} failing`
        : "availability probe idle",
    meta: claudeTraffic.active
      ? `${claudeTraffic.active} live`
      : claudeTraffic.queued
        ? `${claudeTraffic.queued} queued`
        : claudeTraffic.recent
          ? `${claudeTraffic.recent} recent`
          : claudeLoggedIn
            ? "ready"
            : "auth down",
  });

  externalProviders.forEach((provider, index) => {
    const providerId = normalizeProviderId(provider.provider);
    const stats = providerStats.get(providerId) || {
      recent: 0,
      active: 0,
      queued: 0,
    };
    rows.push({
      state: stats.active ? "ok" : stats.queued ? "warn" : "ok",
      label: index === 0 ? "Fallback" : "Alt",
      name: humanizeProvider(provider.provider),
      detail: `${humanizeModel(provider.model)}${
        provider.extraModels?.length
          ? ` +${provider.extraModels.length}`
          : ""
      }`,
      meta: stats.active
        ? `${stats.active} live`
        : stats.queued
          ? `${stats.queued} queued`
          : provider.transport === "local-cli"
            ? "local cli"
            : "ready",
    });
  });

  return rows;
}

function buildRouteSummary(snapshot) {
  const activeConversation = asArray(snapshot?.recentConversations).find(
    (conversation) => conversation.status === "active",
  );
  const queuedConversation = asArray(snapshot?.recentConversations).find(
    (conversation) => conversation.status === "queued",
  );
  const availability = snapshot?.availability || {};
  const externalProviders = asArray(snapshot?.config?.externalProviders);

  if (activeConversation) {
    const startLog = findRecentLog(
      activeConversation.conversationId,
      (entry) => entry.event === "request.start",
    );
    const route = buildRouteInfo({
      snapshot,
      model: activeConversation.model,
      startLog,
    });
    return {
      label: `${route.providerName} live`,
      providerMode: route.providerName,
    };
  }

  if (queuedConversation) {
    const startLog = findRecentLog(
      queuedConversation.conversationId,
      (entry) => entry.event === "request.start",
    );
    const route = buildRouteInfo({
      snapshot,
      model: queuedConversation.model,
      startLog,
    });
    return {
      label: `${route.providerName} queued`,
      providerMode: route.providerName,
    };
  }

  if (asArray(availability.available).length > 0 && externalProviders.length > 0) {
    return {
      label: "Claude primary + fallback",
      providerMode: "Hybrid",
    };
  }

  if (asArray(availability.available).length > 0) {
    return {
      label: "Claude primary",
      providerMode: "Claude",
    };
  }

  if (externalProviders.length > 0) {
    return {
      label: `${humanizeProvider(externalProviders[0].provider)} fallback`,
      providerMode: humanizeProvider(externalProviders[0].provider),
    };
  }

  return {
    label: "No route",
    providerMode: "Offline",
  };
}

function buildSignals(snapshot, latest) {
  const availability = snapshot?.availability || {};
  const pool = snapshot?.pool || {};
  const store = snapshot?.store || {};
  const providers = buildProviderRows(snapshot);
  const warmedAt = pool?.warmedAt ? Date.parse(pool.warmedAt) : 0;
  const authLabel =
    availability?.auth?.loggedIn === false
      ? "signed out"
      : availability?.auth?.authMethod
        ? String(availability.auth.authMethod)
        : "unknown";

  return [
    {
      state: latest.throughput > 0 ? "ok" : "",
      label: "Ingress",
      value: `${formatFloat(latest.throughput, 2)} req/s`,
      meta: `${formatCount(latest.httpInflight)} HTTP in flight`,
      badge: latest.throughput > 0 ? "flow" : "idle",
    },
    {
      state: snapshot?.queue?.queuedRequests ? "warn" : "",
      label: "Queue",
      value: `${formatCount(snapshot?.queue?.queuedRequests)} waiting`,
      meta: `oldest ${formatDuration(snapshot?.queue?.oldestQueueWaitMs)}`,
      badge: `${formatCount(snapshot?.queue?.maxConcurrentRequests)} cap`,
    },
    {
      state: snapshot?.runtime?.activeRequests ? "ok" : "",
      label: "Runtime",
      value: `${formatCount(snapshot?.runtime?.activeRequests)} active`,
      meta: `${formatCount(snapshot?.runtime?.activeSessions)} sessions, ${formatCount(snapshot?.runtime?.activeSubprocesses)} Claude workers`,
      badge: providers.some((provider) => provider.meta.includes("live"))
        ? "live"
        : "idle",
    },
    {
      state: snapshot?.status === "ok" ? "ok" : "alarm",
      label: "Auth",
      value: authLabel,
      meta: availability?.checkedAtMs
        ? `last probe ${formatAge(Date.now() - availability.checkedAtMs)} ago`
        : "probe pending",
      badge:
        availability?.auth?.loggedIn === false
          ? "down"
          : availability?.auth?.apiProvider
            ? String(availability.auth.apiProvider)
            : "ready",
    },
    {
      state: pool?.isWarm ? "ok" : pool ? "warn" : "",
      label: "Pool",
      value: pool
        ? `${formatCount(pool.poolSize)} warm slots`
        : "not ready",
      meta: pool?.warmedAt
        ? `primed ${formatAge(Date.now() - warmedAt)} ago`
        : "warm-up pending",
      badge: pool?.warming ? "warming" : pool?.isWarm ? "primed" : "cold",
    },
    {
      state: store?.messages ? "ok" : "",
      label: "Store",
      value: `${formatCount(store?.conversations)} chats`,
      meta: `${formatCount(store?.messages)} msgs, ${formatCount(store?.metrics)} metric rows`,
      badge: "sqlite",
    },
  ];
}

function buildAlerts(snapshot, latest) {
  const alerts = [];
  const availability = snapshot?.availability || {};
  const externalProviders = asArray(snapshot?.config?.externalProviders);
  const unavailable = asArray(availability.unavailable);
  const stallDetections = asNumber(snapshot?.stallDetections);
  const failureStats = snapshot?.failureStats || {};
  const recentErrors = asArray(snapshot?.recentErrors);

  if (snapshot?.status !== "ok") {
    alerts.push({
      state: "alarm",
      title: "Auth path degraded",
      body: snapshot?.unhealthyReason || "Availability checks are failing repeatedly.",
    });
  }

  if (unavailable.length > 0) {
    alerts.push({
      state: externalProviders.length ? "warn" : "alarm",
      title: "Claude path unavailable",
      body: externalProviders.length
        ? `${unavailable.length} Claude model probes failed. Fallback route remains available.`
        : `${unavailable.length} Claude model probes failed and no fallback route is configured.`,
    });
  }

  if (asNumber(snapshot?.queue?.queuedRequests) > 0) {
    alerts.push({
      state: "warn",
      title: "Queue pressure",
      body: `${formatCount(snapshot.queue.queuedRequests)} waiting, oldest hold ${formatDuration(snapshot.queue.oldestQueueWaitMs)}.`,
    });
  }

  if (stallDetections > 0) {
    alerts.push({
      state: "alarm",
      title: "Stall detections recorded",
      body: `${formatCount(stallDetections)} stall event${stallDetections === 1 ? "" : "s"} observed since boot.`,
    });
  }

  if (asNumber(failureStats.totalFailures) > 0) {
    alerts.push({
      state: "warn",
      title: "Session resume failures",
      body: `${formatCount(failureStats.totalFailures)} failure${failureStats.totalFailures === 1 ? "" : "s"} across ${formatCount(failureStats.sessionsWithFailures)} session${failureStats.sessionsWithFailures === 1 ? "" : "s"}.`,
    });
  }

  if (latest.errorRate > 0) {
    alerts.push({
      state: "warn",
      title: "Errors in current window",
      body: `${formatFloat(latest.errorRate, 1)} anomaly events per minute across request and stall counters.`,
    });
  }

  if (recentErrors.length > 0) {
    const latestError = recentErrors[0];
    alerts.push({
      state: "warn",
      title: "Recent stored error",
      body: String(latestError?.error || latestError?.event || "Proxy error recorded."),
    });
  }

  if (!alerts.length) {
    alerts.push({
      state: "ok",
      title: "No active alerts",
      body: "Auth, queue, sessions, and route pressure are currently quiet.",
    });
  }

  return alerts.slice(0, 6);
}

function buildConversationMaps(snapshot) {
  const summaries = new Map();
  asArray(snapshot?.recentConversations).forEach((conversation) => {
    summaries.set(conversation.conversationId, conversation);
  });

  const queueStates = new Map();
  asArray(snapshot?.queue?.conversations).forEach((conversation) => {
    queueStates.set(conversation.conversationId, conversation);
  });

  const activeRequests = new Map();
  asArray(snapshot?.queue?.activeRequests).forEach((conversation) => {
    activeRequests.set(conversation.conversationId, conversation);
  });

  return { summaries, queueStates, activeRequests };
}

function buildLaneItems(snapshot) {
  const maps = buildConversationMaps(snapshot);
  const items = [];
  const seen = new Set();

  asArray(snapshot?.queue?.activeRequests).forEach((activeRequest) => {
    const conversation = maps.summaries.get(activeRequest.conversationId) || null;
    const startLog = findRecentLog(
      activeRequest.conversationId,
      (entry) => entry.event === "request.start",
    );
    const route = buildRouteInfo({
      snapshot,
      model: conversation?.model || startLog?.model,
      startLog,
    });

    items.push({
      key: activeRequest.conversationId,
      status: "active",
      sortValue: asNumber(activeRequest.durationMs),
      route,
      conversation,
      activeRequest,
      queueState: maps.queueStates.get(activeRequest.conversationId) || null,
      preview:
        conversation?.lastMessagePreview ||
        "Execution is active. Awaiting next log or transcript delta.",
    });
    seen.add(activeRequest.conversationId);
  });

  asArray(snapshot?.queue?.conversations).forEach((queueState) => {
    if (seen.has(queueState.conversationId) || asNumber(queueState.queued) <= 0) {
      return;
    }

    const conversation = maps.summaries.get(queueState.conversationId) || null;
    const startLog = findRecentLog(
      queueState.conversationId,
      (entry) => entry.event === "request.start",
    );
    const route = buildRouteInfo({
      snapshot,
      model: conversation?.model || startLog?.model,
      startLog,
    });

    items.push({
      key: queueState.conversationId,
      status: "queued",
      sortValue: asNumber(queueState.waitMs),
      route,
      conversation,
      activeRequest: null,
      queueState,
      preview:
        conversation?.lastMessagePreview ||
        "Conversation is waiting for a free execution slot.",
    });
  });

  return items
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "active" ? -1 : 1;
      }
      return right.sortValue - left.sortValue;
    })
    .slice(0, 10);
}

function setNodeState(element, state) {
  if (!element) return;
  if (state) {
    element.dataset.state = state;
  } else {
    delete element.dataset.state;
  }
}

function setPipeState(element, live, warn, label) {
  if (!element) return;
  element.classList.toggle("is-live", Boolean(live));
  element.classList.toggle("is-warn", Boolean(warn));
  const labelNode = element.querySelector(".pipe-label");
  if (labelNode) {
    labelNode.textContent = label;
  }
}

function renderTopbar(snapshot, latest) {
  const routeSummary = buildRouteSummary(snapshot);
  const totalErrors =
    counterValue(snapshot, "claude_proxy_request_errors_total") +
    counterValue(snapshot, "claude_proxy_subprocess_stalls_total");
  const alerts = buildAlerts(snapshot, latest).filter(
    (alert) => alert.state !== "ok",
  );

  dom.routeSummary.textContent = routeSummary.label;
  dom.activeSummary.textContent = formatCount(snapshot?.runtime?.activeRequests);
  dom.queueSummary.textContent = formatCount(snapshot?.queue?.queuedRequests);
  dom.errorSummary.textContent = formatCount(totalErrors);
  dom.memorySummary.textContent = formatMemory(snapshot?.metricSnapshot?.process?.memoryBytes?.rss);
  dom.systemMode.textContent =
    snapshot?.status !== "ok"
      ? "Degraded"
      : snapshot?.queue?.queuedRequests
        ? "Queued"
        : snapshot?.runtime?.activeRequests
          ? "Flowing"
          : "Idle";
  dom.providerMode.textContent = routeSummary.providerMode;
  dom.alertSummary.textContent = alerts.length
    ? `${alerts.length} active`
    : "Quiet";
}

function renderTopology(snapshot, latest) {
  const queue = snapshot?.queue || {};
  const runtime = snapshot?.runtime || {};
  const availability = snapshot?.availability || {};
  const providers = buildProviderRows(snapshot);
  const providerReadyCount = providers.filter(
    (provider) => provider.state !== "alarm",
  ).length;

  setNodeState(
    dom.nodeClients,
    latest.throughput > 0 ? "ok" : "",
  );
  dom.nodeClientsValue.textContent = `${formatFloat(latest.throughput, 2)} req/s`;
  dom.nodeClientsMeta.textContent = latest.throughput > 0
    ? `${formatCount(counterValue(snapshot, "claude_proxy_request_outcomes_total"))} completed requests since boot`
    : "No active client ingress";
  setPipeState(
    dom.pipeClients,
    latest.throughput > 0,
    latest.errorRate > 0,
    latest.throughput > 0
      ? `${formatFloat(latest.throughput, 2)} req/s`
      : "quiet",
  );

  setNodeState(
    dom.nodeIngress,
    runtime.activeRequests > 0 ? "ok" : queue.queuedRequests > 0 ? "warn" : "",
  );
  dom.nodeIngressValue.textContent = `${formatCount(runtime.activeRequests)} live`;
  dom.nodeIngressMeta.textContent = `${formatCount(latest.httpInflight)} HTTP in flight, ${formatFloat(latest.errorRate, 1)} anomalies/min`;
  setPipeState(
    dom.pipeIngress,
    runtime.activeRequests > 0,
    queue.queuedRequests > 0,
    queue.queuedRequests > 0
      ? `${formatCount(queue.queuedRequests)} queued`
      : "clear",
  );

  setNodeState(
    dom.nodeQueue,
    queue.queuedRequests > 0 ? "warn" : "",
  );
  dom.nodeQueueValue.textContent = `${formatCount(queue.queuedRequests)} waiting`;
  dom.nodeQueueMeta.textContent = queue.queuedRequests > 0
    ? `${formatCount(queue.queuedConversations)} conversations, oldest ${formatDuration(queue.oldestQueueWaitMs)}`
    : `cap ${formatCount(queue.maxConcurrentRequests)}, no backlog`;
  setPipeState(
    dom.pipeQueue,
    runtime.activeRequests > 0,
    queue.queuedRequests > 0,
    runtime.activeRequests > 0
      ? `${formatCount(runtime.activeRequests)} running`
      : "idle",
  );

  setNodeState(
    dom.nodeRuntime,
    runtime.activeRequests > 0 ? "ok" : latest.cpuPercent > 65 ? "warn" : "",
  );
  dom.nodeRuntimeValue.textContent = `${formatCount(runtime.activeRequests)} active`;
  dom.nodeRuntimeMeta.textContent = `${formatCount(runtime.activeSessions)} sessions, ${formatCount(runtime.activeSubprocesses)} Claude workers, ${formatPercent(latest.cpuPercent, 0)} CPU`;
  setPipeState(
    dom.pipeRuntime,
    providerReadyCount > 0 && runtime.activeRequests > 0,
    asArray(availability.unavailable).length > 0 && providerReadyCount === 0,
    buildRouteSummary(snapshot).label,
  );

  setNodeState(
    dom.nodeProviders,
    providerReadyCount > 0 ? "ok" : "alarm",
  );
  dom.nodeProvidersValue.textContent = `${formatCount(providerReadyCount)} ready`;
  dom.nodeProvidersMeta.textContent = buildRouteSummary(snapshot).label;
  dom.providerStack.innerHTML = providers.length
    ? providers
        .map(
          (provider) => `
            <div class="provider-row" data-state="${escapeHtml(provider.state)}">
              <span>${escapeHtml(provider.label)}</span>
              <div>
                <strong>${escapeHtml(provider.name)}</strong>
                <small>${escapeHtml(provider.detail)}</small>
              </div>
              <span class="meta-badge">${escapeHtml(provider.meta)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="provider-row provider-row--empty">No providers configured</div>`;
}

function renderSignals(snapshot, latest) {
  const signals = buildSignals(snapshot, latest);
  const hotSignals = signals.filter(
    (signal) => signal.state === "warn" || signal.state === "alarm",
  ).length;

  dom.signalSummary.textContent = hotSignals
    ? `${hotSignals} hot`
    : `${signals.length} stable`;
  dom.stateStack.innerHTML = signals
    .map(
      (signal) => `
        <div class="state-row" data-state="${escapeHtml(signal.state)}">
          <span>${escapeHtml(signal.label)}</span>
          <div>
            <strong>${escapeHtml(signal.value)}</strong>
            <small>${escapeHtml(signal.meta)}</small>
          </div>
          <span class="meta-badge">${escapeHtml(signal.badge)}</span>
        </div>
      `,
    )
    .join("");
}

function renderAlerts(snapshot, latest) {
  const alerts = buildAlerts(snapshot, latest);
  const actionable = alerts.filter((alert) => alert.state !== "ok");

  dom.alertSummary.textContent = actionable.length
    ? `${actionable.length} active`
    : "Quiet";
  dom.alertStack.innerHTML = alerts
    .map(
      (alert) => `
        <article class="alert-row" data-state="${escapeHtml(alert.state)}">
          <strong>${escapeHtml(alert.title)}</strong>
          <small>${escapeHtml(alert.body)}</small>
        </article>
      `,
    )
    .join("");
}

function renderLanes(snapshot) {
  const lanes = buildLaneItems(snapshot);
  dom.laneSummary.textContent = lanes.length
    ? `${lanes.length} active`
    : "0 active";

  if (!lanes.length) {
    dom.laneList.innerHTML = `<div class="empty-inline">No active or queued chats</div>`;
    return;
  }

  dom.laneList.innerHTML = lanes
    .map((lane) => {
      const timer = lane.status === "active"
        ? formatDuration(lane.activeRequest?.durationMs)
        : formatDuration(lane.queueState?.waitMs);
      const messageCount = lane.conversation?.messageCount ?? 0;
      const queueDepth = lane.queueState?.queued ?? 0;
      return `
        <article class="lane-row" data-state="${escapeHtml(lane.status)}">
          <div class="lane-top">
            <strong class="lane-title">${escapeHtml(lane.route.summary)}</strong>
            <span class="status-badge" data-state="${escapeHtml(statusBadgeState(lane.status))}">${escapeHtml(lane.status)}</span>
          </div>
          <small>${escapeHtml(lane.preview)}</small>
          <div class="lane-meta-row">
            <span class="meta-badge">${escapeHtml(timer)}</span>
            <span class="meta-badge">${escapeHtml(formatCount(messageCount))} msgs</span>
            ${
              lane.status === "queued"
                ? `<span class="meta-badge">${escapeHtml(formatCount(queueDepth))} queued</span>`
                : ""
            }
            <span class="meta-badge">${escapeHtml(shortId(lane.key, 8))}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function buildLegendChips(items) {
  return items
    .map(
      (item) => `
        <span class="legend-chip" style="--legend-color:${escapeHtml(item.color)}">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </span>
      `,
    )
    .join("");
}

function renderEmptyChart(svg, message) {
  svg.innerHTML = `
    <rect x="0" y="0" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" rx="14" fill="rgba(8, 12, 24, 0.35)"></rect>
    <text
      x="50%"
      y="50%"
      text-anchor="middle"
      dominant-baseline="middle"
      fill="rgba(190, 213, 255, 0.6)"
      font-size="14"
      font-family="Manrope, sans-serif"
    >${escapeHtml(message)}</text>
  `;
}

function renderChart(svg, config) {
  const pad = { top: 16, right: 16, bottom: 20, left: 16 };
  const innerWidth = CHART_WIDTH - pad.left - pad.right;
  const innerHeight = CHART_HEIGHT - pad.top - pad.bottom;
  const series = config.series.filter((entry) =>
    entry.values.some((value) => Number.isFinite(Number(value))),
  );

  if (!series.length) {
    renderEmptyChart(svg, "Awaiting live telemetry");
    return;
  }

  const allValues = series.flatMap((entry) =>
    entry.values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value)),
  );
  const maxInput = allValues.length ? Math.max(...allValues) : 1;
  const minInput = config.minValue ?? 0;
  const maxValue = Math.max(
    config.maxValue ?? maxInput * 1.08,
    minInput + 1,
  );
  const minValue = Math.min(minInput, maxValue - 1);
  const pointCount = Math.max(
    series.reduce((max, entry) => Math.max(max, entry.values.length), 0),
    2,
  );

  const mapX = (index) =>
    pad.left + (index / (pointCount - 1)) * innerWidth;
  const mapY = (value) =>
    pad.top + innerHeight - ((value - minValue) / (maxValue - minValue)) * innerHeight;

  let defs = "";
  let grid = "";
  let paths = "";
  let labels = "";

  for (let step = 0; step <= 4; step += 1) {
    const y = pad.top + (innerHeight / 4) * step;
    grid += `<line x1="${pad.left}" y1="${y}" x2="${CHART_WIDTH - pad.right}" y2="${y}" stroke="rgba(126, 192, 255, 0.1)" stroke-width="1"></line>`;
  }

  for (let step = 0; step <= 5; step += 1) {
    const x = pad.left + (innerWidth / 5) * step;
    grid += `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${CHART_HEIGHT - pad.bottom}" stroke="rgba(126, 192, 255, 0.05)" stroke-width="1"></line>`;
  }

  series.forEach((entry, index) => {
    const points = entry.values
      .map((value, valueIndex) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return null;
        return {
          x: mapX(valueIndex),
          y: mapY(numeric),
          value: numeric,
        };
      })
      .filter(Boolean);

    if (!points.length) return;

    const linePath = points
      .map((point, pointIndex) =>
        `${pointIndex === 0 ? "M" : "L"} ${point.x} ${point.y}`,
      )
      .join(" ");

    if (entry.fill) {
      const gradientId = `${svg.id}-gradient-${index}`;
      defs += `
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${entry.color}" stop-opacity="0.34"></stop>
          <stop offset="100%" stop-color="${entry.color}" stop-opacity="0.02"></stop>
        </linearGradient>
      `;
      const baseline = mapY(minValue);
      const areaPath = `${linePath} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z`;
      paths += `<path d="${areaPath}" fill="url(#${gradientId})" stroke="none"></path>`;
    }

    paths += `<path d="${linePath}" fill="none" stroke="${entry.color}" stroke-width="${entry.strokeWidth || 2.2}" stroke-linecap="round" stroke-linejoin="round"></path>`;
    const last = points[points.length - 1];
    paths += `<circle cx="${last.x}" cy="${last.y}" r="2.5" fill="${entry.color}" stroke="rgba(4, 8, 18, 0.9)" stroke-width="1.5"></circle>`;
  });

  labels += `
    <text x="${pad.left}" y="11" fill="rgba(196, 214, 255, 0.62)" font-size="11" font-family="IBM Plex Mono, monospace">${escapeHtml(config.topLabel)}</text>
    <text x="${pad.left}" y="${CHART_HEIGHT - 5}" fill="rgba(196, 214, 255, 0.42)" font-size="11" font-family="IBM Plex Mono, monospace">${escapeHtml(config.bottomLabel)}</text>
  `;

  svg.innerHTML = `<defs>${defs}</defs>${grid}${labels}${paths}`;
}

function renderCharts(snapshot) {
  const latest = state.history[state.history.length - 1]?.derived;
  if (!latest) return;

  const series = state.history.map((entry) => entry.derived);
  const flowValues = series.map((entry) => entry.throughput);
  const errorValues = series.map((entry) => entry.errorRate);
  const retryValues = series.map((entry) => entry.retryRate);
  const p50Values = series.map((entry) => entry.p50);
  const p95Values = series.map((entry) => entry.p95);
  const ttfbValues = series.map((entry) => entry.ttfb95);
  const activeValues = series.map((entry) => entry.activeRequests);
  const queuedValues = series.map((entry) => entry.queuedRequests);
  const sessionValues = series.map((entry) => entry.activeSessions);
  const cpuValues = series.map((entry) => entry.cpuPercent);
  const rssValues = series.map((entry) => entry.rss / (1024 * 1024));
  const heapValues = series.map((entry) => entry.heapUsed / (1024 * 1024));

  dom.flowCurrent.textContent = `${formatFloat(latest.throughput, 2)} req/s`;
  dom.flowLegend.innerHTML = buildLegendChips([
    { label: "Req/s", value: formatFloat(latest.throughput, 2), color: "#36c8ff" },
    { label: "Err/min", value: formatFloat(latest.errorRate, 1), color: "#ff8d69" },
    { label: "Retry/min", value: formatFloat(latest.retryRate, 1), color: "#ffd66b" },
  ]);
  renderChart(dom.flowChart, {
    topLabel: `${formatFloat(Math.max(...flowValues, 1), 2)} req/s`,
    bottomLabel: "0",
    series: [
      { values: flowValues, color: "#36c8ff", fill: true, strokeWidth: 2.5 },
      { values: errorValues, color: "#ff8d69", fill: false, strokeWidth: 1.8 },
      { values: retryValues, color: "#ffd66b", fill: false, strokeWidth: 1.6 },
    ],
  });

  dom.latencyCurrent.textContent = latest.p95
    ? `${formatDuration(latest.p95)} p95`
    : "no samples";
  dom.latencyLegend.innerHTML = buildLegendChips([
    { label: "P50", value: latest.p50 ? formatDuration(latest.p50) : "n/a", color: "#36c8ff" },
    { label: "P95", value: latest.p95 ? formatDuration(latest.p95) : "n/a", color: "#ff8d69" },
    { label: "TTFB95", value: latest.ttfb95 ? formatDuration(latest.ttfb95) : "n/a", color: "#74ffb0" },
  ]);
  renderChart(dom.latencyChart, {
    topLabel: latest.p95
      ? formatDuration(Math.max(...p95Values.filter(Boolean), latest.p95))
      : "no samples",
    bottomLabel: "0",
    series: [
      { values: p50Values, color: "#36c8ff", fill: false, strokeWidth: 1.8 },
      { values: p95Values, color: "#ff8d69", fill: true, strokeWidth: 2.4 },
      { values: ttfbValues, color: "#74ffb0", fill: false, strokeWidth: 1.7 },
    ],
  });

  dom.pressureCurrent.textContent = `${formatCount(latest.activeRequests)} / ${formatCount(latest.queuedRequests)}`;
  dom.pressureLegend.innerHTML = buildLegendChips([
    { label: "Active", value: formatCount(latest.activeRequests), color: "#74ffb0" },
    { label: "Queued", value: formatCount(latest.queuedRequests), color: "#ffd66b" },
    { label: "Sessions", value: formatCount(latest.activeSessions), color: "#ff4fa8" },
  ]);
  renderChart(dom.pressureChart, {
    topLabel: formatCount(
      Math.max(
        ...activeValues,
        ...queuedValues,
        ...sessionValues,
        asNumber(snapshot?.queue?.maxConcurrentRequests),
        1,
      ),
    ),
    bottomLabel: "0",
    series: [
      { values: activeValues, color: "#74ffb0", fill: true, strokeWidth: 2.2 },
      { values: queuedValues, color: "#ffd66b", fill: false, strokeWidth: 1.8 },
      { values: sessionValues, color: "#ff4fa8", fill: false, strokeWidth: 1.7 },
    ],
  });

  dom.loadCurrent.textContent = `${formatPercent(latest.cpuPercent, 0)} / ${formatMemory(latest.rss)}`;
  dom.loadLegend.innerHTML = buildLegendChips([
    { label: "CPU", value: formatPercent(latest.cpuPercent, 0), color: "#36c8ff" },
    { label: "RSS", value: formatMemory(latest.rss), color: "#74ffb0" },
    { label: "Heap", value: formatMemory(latest.heapUsed), color: "#ff4fa8" },
  ]);
  renderChart(dom.loadChart, {
    topLabel: `${formatPercent(Math.max(...cpuValues, 1), 0)} / ${Math.round(Math.max(...rssValues, 1))} MB`,
    bottomLabel: "0",
    series: [
      { values: cpuValues, color: "#36c8ff", fill: false, strokeWidth: 1.9 },
      { values: rssValues, color: "#74ffb0", fill: true, strokeWidth: 2.2 },
      { values: heapValues, color: "#ff4fa8", fill: false, strokeWidth: 1.6 },
    ],
  });
}

function ensureSelectedConversation(snapshot) {
  const conversations = asArray(snapshot?.recentConversations);
  const exists = conversations.some(
    (conversation) => conversation.conversationId === state.selectedConversationId,
  );
  if (exists) return;
  state.selectedConversationId = conversations[0]?.conversationId || null;
}

function renderConversations(snapshot) {
  const conversations = asArray(snapshot?.recentConversations);
  ensureSelectedConversation(snapshot);

  dom.conversationCounts.textContent = `${formatCount(conversations.length)} tracked`;

  if (!conversations.length) {
    dom.conversationList.innerHTML = `<div class="empty-inline">No chats</div>`;
    return;
  }

  dom.conversationList.innerHTML = conversations
    .map((conversation) => {
      const startLog = findRecentLog(
        conversation.conversationId,
        (entry) => entry.event === "request.start",
      );
      const route = buildRouteInfo({
        snapshot,
        model: conversation.model,
        startLog,
      });
      const selected =
        conversation.conversationId === state.selectedConversationId;
      const timer = conversation.status === "active"
        ? formatDuration(conversation.activeDurationMs)
        : conversation.status === "queued"
          ? formatDuration(conversation.queueWaitMs)
          : `idle ${formatAge(conversation.idleMs)}`;

      return `
        <article
          tabindex="0"
          class="conversation-row${selected ? " is-selected" : ""}"
          data-status="${escapeHtml(conversation.status)}"
          data-conversation-id="${escapeHtml(conversation.conversationId)}"
        >
          <div class="conversation-top">
            <div class="conversation-route">
              <strong>${escapeHtml(route.summary)}</strong>
            </div>
            <span class="status-badge" data-state="${escapeHtml(statusBadgeState(conversation.status))}">${escapeHtml(conversation.status)}</span>
          </div>
          <div class="conversation-preview">${escapeHtml(
            conversation.lastMessagePreview || "No transcript preview captured yet.",
          )}</div>
          <div class="conversation-meta-row">
            <span class="meta-badge">${escapeHtml(timer)}</span>
            <span class="meta-badge">${escapeHtml(formatCount(conversation.messageCount))} msgs</span>
            <span class="meta-badge">${escapeHtml(shortId(conversation.conversationId, 8))}</span>
          </div>
        </article>
      `;
    })
    .join("");

  Array.from(dom.conversationList.querySelectorAll(".conversation-row")).forEach(
    (row) => {
      const selectConversation = () => {
        state.selectedConversationId = row.getAttribute("data-conversation-id");
        renderConversations(snapshot);
        loadConversationDetail(state.selectedConversationId);
      };

      row.addEventListener("click", selectConversation);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectConversation();
        }
      });
    },
  );
}

function renderConversationDetail(snapshot) {
  const detail = state.conversationDetail;
  const selectedSummary = asArray(snapshot?.recentConversations).find(
    (conversation) => conversation.conversationId === state.selectedConversationId,
  ) || null;

  if (!selectedSummary) {
    dom.detailTitle.textContent = "Select a chat";
    dom.detailRoute.textContent = "no route";
    dom.detailTimer.textContent = "idle";
    dom.detailMeta.innerHTML = `<div class="empty-inline">No chat selected</div>`;
    dom.conversationDetail.innerHTML = `
      <div class="empty-inline">Select a row to inspect transcript and runtime context</div>
    `;
    return;
  }

  const startLog = findRecentLog(
    selectedSummary.conversationId,
    (entry) => entry.event === "request.start",
  );
  const route = buildRouteInfo({
    snapshot,
    model: selectedSummary.model,
    startLog,
  });
  const timer = selectedSummary.status === "active"
    ? formatDuration(selectedSummary.activeDurationMs)
    : selectedSummary.status === "queued"
      ? formatDuration(selectedSummary.queueWaitMs)
      : `idle ${formatAge(selectedSummary.idleMs)}`;

  dom.detailTitle.textContent = route.modelName;
  dom.detailRoute.textContent = route.summary;
  dom.detailTimer.textContent = timer;
  dom.detailMeta.innerHTML = [
    {
      label: "Status",
      value: selectedSummary.status,
    },
    {
      label: "Messages",
      value: `${formatCount(selectedSummary.messageCount)} total`,
    },
    {
      label: "Conversation",
      value: shortId(selectedSummary.conversationId, 12),
    },
    {
      label: "Session",
      value: detail?.session?.sessionIdShort || "none",
    },
    {
      label: "Queue",
      value: detail?.queue
        ? `${formatCount(detail.queue.queued)} queued`
        : "clear",
    },
    {
      label: "Updated",
      value: formatAge(selectedSummary.idleMs),
    },
  ]
    .map(
      (item) => `
        <div class="detail-meta-item">
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.value)}</small>
        </div>
      `,
    )
    .join("");

  if (!detail || !Array.isArray(detail.messages) || !detail.messages.length) {
    dom.conversationDetail.innerHTML = `
      <div class="empty-inline">Transcript not loaded yet</div>
    `;
    return;
  }

  dom.conversationDetail.innerHTML = detail.messages
    .map(
      (message) => `
        <article class="message-card" data-role="${escapeHtml(message.role || "unknown")}">
          <div class="message-head">
            <strong class="message-role">${escapeHtml(message.role || "message")}</strong>
            <span class="message-meta">${escapeHtml(
              new Date(message.created_at).toLocaleTimeString([], {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }),
            )}</span>
          </div>
          <div class="message-body">${escapeHtml(message.content || "")}</div>
        </article>
      `,
    )
    .join("");
}

function getLogKind(eventName) {
  if (!eventName) return "other";
  if (eventName.startsWith("request.")) return "request";
  if (eventName.startsWith("queue.")) return "queue";
  if (eventName.startsWith("subprocess.")) return "subprocess";
  if (eventName.startsWith("session.")) return "session";
  if (eventName.startsWith("auth.")) return "auth";
  if (eventName.startsWith("pool.")) return "pool";
  if (eventName.startsWith("cli.")) return "cli";
  return "other";
}

function summarizeLogEntry(entry) {
  const kind = getLogKind(entry?.event);
  const route = buildRouteInfo({
    snapshot: state.snapshot,
    model: entry?.model,
    startLog: entry,
  });
  const idBits = [];
  if (entry?.conversationId) {
    idBits.push(`chat ${shortId(entry.conversationId, 8)}`);
  }
  if (entry?.requestId) {
    idBits.push(`req ${shortId(entry.requestId, 8)}`);
  }
  if (entry?.pid) {
    idBits.push(`pid ${entry.pid}`);
  }

  switch (entry?.event) {
    case "request.start":
      return {
        kind,
        title: "Request start",
        summary: `${route.summary}${entry?.stream ? " / stream" : ""}`,
        detail: [
          entry?.queueDepth != null ? `queue ${entry.queueDepth}` : "",
          entry?.fallbackUsed ? "fallback" : "",
          ...idBits,
        ]
          .filter(Boolean)
          .join(" • "),
      };
    case "request.complete":
      return {
        kind,
        title: "Request complete",
        summary: `${route.modelName}${entry?.durationMs ? ` in ${formatDuration(entry.durationMs)}` : ""}`,
        detail: [
          entry?.responseLength != null ? `${formatCompact(entry.responseLength)} chars` : "",
          ...idBits,
        ]
          .filter(Boolean)
          .join(" • "),
      };
    case "request.error":
      return {
        kind,
        title: "Request error",
        summary: String(entry?.reason || "Execution failed"),
        detail: [route.summary, ...idBits].filter(Boolean).join(" • "),
      };
    case "request.timeout":
      return {
        kind,
        title: "Request timeout",
        summary: entry?.durationMs
          ? `timed out after ${formatDuration(entry.durationMs)}`
          : "execution timed out",
        detail: [route.summary, ...idBits].filter(Boolean).join(" • "),
      };
    case "queue.enqueue":
      return {
        kind,
        title: "Queue enqueue",
        summary: `${formatCount(entry?.depth)} deep`,
        detail: idBits.join(" • "),
      };
    case "queue.timeout":
      return {
        kind,
        title: "Queue timeout",
        summary: entry?.timeoutMs
          ? `wait exceeded ${formatDuration(entry.timeoutMs)}`
          : "queue wait exceeded timeout",
        detail: idBits.join(" • "),
      };
    case "subprocess.spawn":
      return {
        kind,
        title: "Claude worker spawn",
        summary: `${humanizeModel(entry?.model)} / ${entry?.reasoningMode || "off"}`,
        detail: [
          entry?.thinking ? `effort ${entry.thinking}` : "",
          ...idBits,
        ]
          .filter(Boolean)
          .join(" • "),
      };
    case "subprocess.close":
      return {
        kind,
        title: "Claude worker close",
        summary: `exit ${entry?.code ?? "unknown"}`,
        detail: idBits.join(" • "),
      };
    case "auth.failure":
      return {
        kind,
        title: "Auth failure",
        summary: String(entry?.reason || "Authentication check failed"),
        detail: idBits.join(" • "),
      };
    case "pool.warmed":
      return {
        kind,
        title: "Warm pool primed",
        summary: `${formatCount(entry?.poolSize)} slots ready`,
        detail: entry?.durationMs
          ? `warm-up ${formatDuration(entry.durationMs)}`
          : "",
      };
    case "server.start":
      return {
        kind,
        title: "Server start",
        summary: entry?.port ? `listening on :${entry.port}` : "server online",
        detail: "",
      };
    default:
      return {
        kind,
        title: titleCase(String(entry?.event || "event")),
        summary: String(entry?.reason || entry?.model || "No extra detail"),
        detail: idBits.join(" • "),
      };
  }
}

function renderLogs() {
  const filterValue = dom.logEventFilter.value;
  const searchTerm = dom.logSearch.value.trim().toLowerCase();

  const filtered = state.logs.filter((entry) => {
    if (filterValue !== "all" && !String(entry?.event || "").startsWith(filterValue)) {
      return false;
    }
    if (!searchTerm) return true;
    const summary = summarizeLogEntry(entry);
    const haystack = [
      entry?.event,
      entry?.conversationId,
      entry?.requestId,
      entry?.reason,
      entry?.model,
      entry?.pid,
      summary.title,
      summary.summary,
      summary.detail,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(searchTerm);
  });

  if (!filtered.length) {
    dom.logStream.innerHTML = `<div class="empty-inline">No logs match the current filter</div>`;
    return;
  }

  dom.logStream.innerHTML = filtered
    .slice(-240)
    .map((entry) => {
      const summary = summarizeLogEntry(entry);
      return `
        <article class="log-row" data-kind="${escapeHtml(summary.kind)}">
          <div class="log-top">
            <strong class="log-event">${escapeHtml(summary.title)}</strong>
            <span class="log-meta">${escapeHtml(
              new Date(entry.ts).toLocaleTimeString([], {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }),
            )}</span>
          </div>
          <div class="log-summary">${escapeHtml(summary.summary)}</div>
          <div class="log-body">${escapeHtml(summary.detail || entry.event)}</div>
        </article>
      `;
    })
    .join("");

  if (state.followLogs) {
    requestAnimationFrame(() => {
      dom.logStream.scrollTop = dom.logStream.scrollHeight;
    });
  }
}

function refreshToolbarState() {
  dom.followLogsButton.classList.toggle("is-active", state.followLogs);
  dom.pauseLogsButton.classList.toggle("is-active", state.logPaused);
}

function maybeRefreshConversationDetail(snapshot) {
  if (!state.selectedConversationId) return;
  const summary = asArray(snapshot?.recentConversations).find(
    (conversation) => conversation.conversationId === state.selectedConversationId,
  );
  if (!summary) return;
  if (
    !state.conversationDetail ||
    state.conversationDetail.conversationId !== state.selectedConversationId
  ) {
    loadConversationDetail(state.selectedConversationId);
    return;
  }
  const knownUpdatedAt = asNumber(state.conversationDetail?.conversation?.updated_at);
  if (!knownUpdatedAt || knownUpdatedAt !== asNumber(summary.updatedAtMs)) {
    loadConversationDetail(state.selectedConversationId);
  }
}

function renderDashboard() {
  if (!state.snapshot || !state.history.length) return;
  const latest = state.history[state.history.length - 1].derived;
  renderTopbar(state.snapshot, latest);
  renderTopology(state.snapshot, latest);
  renderSignals(state.snapshot, latest);
  renderAlerts(state.snapshot, latest);
  renderLanes(state.snapshot);
  renderCharts(state.snapshot);
  renderConversations(state.snapshot);
  renderConversationDetail(state.snapshot);
  if (!state.logPaused) {
    renderLogs();
  }
}

function handleLiveLog(entry) {
  const last = state.logs[state.logs.length - 1];
  const currentKey = JSON.stringify([
    entry?.ts,
    entry?.event,
    entry?.conversationId,
    entry?.requestId,
    entry?.pid,
    entry?.reason,
  ]);
  const lastKey = last
    ? JSON.stringify([
        last.ts,
        last.event,
        last.conversationId,
        last.requestId,
        last.pid,
        last.reason,
      ])
    : "";
  if (currentKey === lastKey) return;

  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_LOGS);
  }
  if (!state.logPaused) {
    renderLogs();
  }
}

function applySnapshot(snapshot, options = {}) {
  state.snapshot = snapshot;
  state.lastSnapshotAt = Date.now();
  pushHistory(snapshot);
  if (Array.isArray(options.logs)) {
    state.logs = options.logs.slice(-MAX_LOGS);
  }
  ensureSelectedConversation(snapshot);
  renderDashboard();
  maybeRefreshConversationDetail(snapshot);
}

function fetchJson(url) {
  return fetch(url, { cache: "no-store" }).then((response) => {
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json();
  });
}

function loadConversationDetail(conversationId) {
  if (!conversationId) return;
  state.detailRequestId += 1;
  const requestId = state.detailRequestId;

  fetchJson(`/ops/conversations/${encodeURIComponent(conversationId)}?limit=${DETAIL_LIMIT}`)
    .then((detail) => {
      if (requestId !== state.detailRequestId) return;
      state.conversationDetail = detail;
      renderConversationDetail(state.snapshot);
    })
    .catch((error) => {
      if (requestId !== state.detailRequestId) return;
      dom.conversationDetail.innerHTML = `
        <div class="empty-inline">Failed to load transcript: ${escapeHtml(error.message)}</div>
      `;
    });
}

function connectStream() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const source = new EventSource("/ops/stream");
  state.eventSource = source;

  source.addEventListener("open", () => {
    setConnected(true);
  });

  source.addEventListener("snapshot", (event) => {
    const snapshot = JSON.parse(event.data);
    applySnapshot(snapshot);
  });

  source.addEventListener("log", (event) => {
    handleLiveLog(JSON.parse(event.data));
  });

  source.addEventListener("error", () => {
    setConnected(false);
  });
}

function bootstrap() {
  refreshToolbarState();
  updateClock();
  setInterval(updateClock, 1000);

  dom.followLogsButton.addEventListener("click", () => {
    state.followLogs = !state.followLogs;
    refreshToolbarState();
    if (!state.logPaused) {
      renderLogs();
    }
  });

  dom.pauseLogsButton.addEventListener("click", () => {
    state.logPaused = !state.logPaused;
    refreshToolbarState();
    if (!state.logPaused) {
      renderLogs();
    }
  });

  dom.logEventFilter.addEventListener("change", () => {
    renderLogs();
  });

  dom.logSearch.addEventListener("input", () => {
    renderLogs();
  });

  fetchJson("/ops/snapshot")
    .then((snapshot) => {
      applySnapshot(snapshot, { logs: snapshot.recentLogs || [] });
      connectStream();
      if (state.selectedConversationId) {
        loadConversationDetail(state.selectedConversationId);
      }
    })
    .catch((error) => {
      dom.connectionLabel.textContent = "Boot failure";
      dom.logStream.innerHTML = `
        <div class="empty-inline">Failed to load ops snapshot: ${escapeHtml(error.message)}</div>
      `;
    });
}

bootstrap();
