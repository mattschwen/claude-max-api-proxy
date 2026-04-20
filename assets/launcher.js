const links = readJson("launchLinks");
const initialSnapshot = readJson("launchSnapshot");

const MAX_LOGS = 80;

const state = {
  snapshot: initialSnapshot,
  logs: Array.isArray(initialSnapshot?.recentLogs)
    ? initialSnapshot.recentLogs.slice(-MAX_LOGS)
    : [],
  eventSource: null,
  models: [],
  connected: false,
  lab: {
    messages: [],
    pendingMessageId: null,
    sending: false,
    controller: null,
    conversationId: generateConversationId(),
  },
};

const dom = {
  labCta: document.getElementById("labCta"),
  dashboardCta: document.getElementById("dashboardCta"),
  webUiCta: document.getElementById("webUiCta"),
  snapshotCta: document.getElementById("snapshotCta"),
  dashboardLink: document.getElementById("dashboardLink"),
  webUiLink: document.getElementById("webUiLink"),
  metricsJsonLink: document.getElementById("metricsJsonLink"),
  healthLink: document.getElementById("healthLink"),
  snapshotLink: document.getElementById("snapshotLink"),
  modelsLink: document.getElementById("modelsLink"),
  dashboardUrl: document.getElementById("dashboardUrl"),
  chatCompletionsUrl: document.getElementById("chatCompletionsUrl"),
  webUiUrl: document.getElementById("webUiUrl"),
  metricsJsonUrl: document.getElementById("metricsJsonUrl"),
  dashboardAliasUrl: document.getElementById("dashboardAliasUrl"),
  labEndpointSummary: document.getElementById("labEndpointSummary"),
  metricActiveRequests: document.getElementById("metricActiveRequests"),
  metricActiveRequestsNote: document.getElementById("metricActiveRequestsNote"),
  metricQueuedRequests: document.getElementById("metricQueuedRequests"),
  metricQueuedRequestsNote: document.getElementById("metricQueuedRequestsNote"),
  metricSessions: document.getElementById("metricSessions"),
  metricSessionsNote: document.getElementById("metricSessionsNote"),
  metricSubprocesses: document.getElementById("metricSubprocesses"),
  metricSubprocessesNote: document.getElementById("metricSubprocessesNote"),
  runtimeStamp: document.getElementById("runtimeStamp"),
  heroSummary: document.getElementById("heroSummary"),
  stackMode: document.getElementById("stackMode"),
  runtimeRefreshStamp: document.getElementById("runtimeRefreshStamp"),
  sessionCountBadge: document.getElementById("sessionCountBadge"),
  logCountBadge: document.getElementById("logCountBadge"),
  footerSummary: document.getElementById("footerSummary"),
  conversationList: document.getElementById("conversationList"),
  sessionList: document.getElementById("sessionList"),
  logList: document.getElementById("logList"),
  labStatusPill: document.getElementById("labStatusPill"),
  labModelSelect: document.getElementById("labModelSelect"),
  labModelInput: document.getElementById("labModelInput"),
  labConversationInput: document.getElementById("labConversationInput"),
  labSystemInput: document.getElementById("labSystemInput"),
  labTranscript: document.getElementById("labTranscript"),
  labPromptInput: document.getElementById("labPromptInput"),
  labStreamToggle: document.getElementById("labStreamToggle"),
  labSendButton: document.getElementById("labSendButton"),
  labStopButton: document.getElementById("labStopButton"),
  labResetButton: document.getElementById("labResetButton"),
  labConversationBadge: document.getElementById("labConversationBadge"),
  labModelBadge: document.getElementById("labModelBadge"),
  labLatencyBadge: document.getElementById("labLatencyBadge"),
  labEndpointValue: document.getElementById("labEndpointValue"),
  labResponseModel: document.getElementById("labResponseModel"),
  labResponseStatus: document.getElementById("labResponseStatus"),
  labResponseConversation: document.getElementById("labResponseConversation"),
  labRequestPreview: document.getElementById("labRequestPreview"),
  labRawOutput: document.getElementById("labRawOutput"),
};

function readJson(id) {
  const element = document.getElementById(id);
  if (!element) return null;
  try {
    return JSON.parse(element.textContent || "null");
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function formatFloat(value, digits = 1) {
  if (!Number.isFinite(Number(value))) return "0";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return "0 ms";
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value < 60_000) return `${Math.round(value / 1000)} s`;
  if (value < 3_600_000) {
    return `${(value / 60_000).toFixed(1)} min`;
  }
  return `${(value / 3_600_000).toFixed(1)} hr`;
}

function formatAge(ms) {
  if (!Number.isFinite(Number(ms))) return "now";
  const value = Math.max(0, Number(ms));
  if (value < 1000) return "now";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m`;
  return `${Math.floor(value / 3_600_000)}h`;
}

function shortId(value, length = 12) {
  return value ? String(value).slice(0, length) : "n/a";
}

function stamp(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function humanizeModel(model) {
  const raw = String(model || "").trim();
  if (!raw) return "Model pending";
  if (raw.startsWith("claude-")) return raw.replace(/^claude-/, "Claude ");
  if (raw.startsWith("gemini-")) return raw.replace(/^gemini-/, "Gemini ");
  if (raw.startsWith("glm-")) return raw.replace(/^glm-/, "GLM ");
  return raw;
}

function readCurrentModel() {
  const custom = dom.labModelInput.value.trim();
  return custom || dom.labModelSelect.value || "default";
}

function generateConversationId() {
  return `lab-${Date.now().toString(36)}`;
}

function makeMessageId() {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function setStatusPill(element, text, stateName) {
  element.textContent = text;
  element.dataset.state = stateName;
}

function setLinks() {
  dom.labCta.href = "#chatLab";
  dom.dashboardCta.href = links.commandDeck;
  dom.webUiCta.href = links.openWebUi;
  dom.snapshotCta.href = `${links.snapshot}?conversationLimit=10&logLimit=16`;
  dom.dashboardLink.href = links.commandDeck;
  dom.webUiLink.href = links.openWebUi;
  dom.metricsJsonLink.href = links.metricsJson;
  dom.healthLink.href = links.health;
  dom.snapshotLink.href = `${links.snapshot}?conversationLimit=10&logLimit=16`;
  dom.modelsLink.href = links.models;

  dom.dashboardUrl.textContent = links.commandDeck.replace(/^https?:\/\//, "");
  dom.chatCompletionsUrl.textContent = links.chatCompletions.replace(/^https?:\/\//, "");
  dom.webUiUrl.textContent = links.openWebUi.replace(/^https?:\/\//, "");
  dom.metricsJsonUrl.textContent = links.metricsJson.replace(/^https?:\/\//, "");
  dom.dashboardAliasUrl.textContent = links.dashboardAlias.replace(/^https?:\/\//, "");
  dom.labEndpointSummary.textContent = "POST /v1/chat/completions";
  dom.labEndpointValue.textContent = "/v1/chat/completions";
}

function collectSuggestedModels(snapshot) {
  const seen = new Set();
  const models = [];

  const add = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    models.push(normalized);
  };

  add("default");
  add("sonnet");

  (snapshot?.availability?.available || []).forEach((entry) => add(entry.id));
  (snapshot?.availability?.unavailable || []).forEach((entry) => add(entry.id));
  (snapshot?.recentConversations || []).forEach((entry) => add(entry.model));
  (snapshot?.config?.externalProviders || []).forEach((provider) => {
    add(provider.model);
    (provider.extraModels || []).forEach((model) => add(model));
  });

  return models;
}

function updateModelChoices(models) {
  const current = readCurrentModel();
  const choices = models.length ? models : collectSuggestedModels(state.snapshot);
  state.models = choices;

  dom.labModelSelect.innerHTML = choices
    .map(
      (model) =>
        `<option value="${escapeHtml(model)}">${escapeHtml(humanizeModel(model))}</option>`,
    )
    .join("");

  if (choices.includes(current)) {
    dom.labModelSelect.value = current;
  }

  renderLabBadges();
}

async function fetchModels() {
  try {
    const response = await fetch(links.models, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.data)
      ? payload.data.map((entry) => entry.id).filter(Boolean)
      : [];
    updateModelChoices(models);
  } catch {
    updateModelChoices([]);
  }
}

function renderLabBadges() {
  dom.labConversationBadge.textContent = shortId(dom.labConversationInput.value.trim(), 16);
  dom.labModelBadge.textContent = humanizeModel(readCurrentModel());
}

function summarizeLog(entry) {
  if (!entry) {
    return {
      title: "No log",
      detail: "No detail",
      stamp: "unknown",
      state: "ready",
    };
  }

  const detailBits = [];
  if (entry.conversationId) detailBits.push(`chat ${shortId(entry.conversationId, 8)}`);
  if (entry.requestId) detailBits.push(`req ${shortId(entry.requestId, 8)}`);
  if (entry.model) detailBits.push(entry.model);
  if (entry.pid) detailBits.push(`pid ${entry.pid}`);
  if (entry.durationMs) detailBits.push(formatDuration(entry.durationMs));

  return {
    title: entry.event,
    detail: entry.reason || detailBits.join(" • ") || "No extra fields",
    stamp: stamp(entry.ts),
    state:
      entry.event === "request.error" || entry.event === "auth.failure"
        ? "error"
        : entry.event?.startsWith("queue.")
          ? "warn"
          : "ready",
  };
}

function renderConversations(snapshot) {
  const conversations = Array.isArray(snapshot?.recentConversations)
    ? snapshot.recentConversations.slice(0, 8)
    : [];

  if (!conversations.length) {
    dom.conversationList.innerHTML =
      '<div class="empty-state">No conversations recorded yet.</div>';
    return;
  }

  dom.conversationList.innerHTML = conversations
    .map((conversation) => {
      const timer = conversation.status === "active"
        ? formatDuration(conversation.activeDurationMs)
        : conversation.status === "queued"
          ? formatDuration(conversation.queueWaitMs)
          : `idle ${formatAge(conversation.idleMs)}`;

      return `
        <article class="stack-item">
          <header>
            <strong>${escapeHtml(humanizeModel(conversation.model))}</strong>
            <span class="status-pill" data-state="${escapeHtml(
              conversation.status === "active"
                ? "running"
                : conversation.status === "queued"
                  ? "warn"
                  : "ready",
            )}">${escapeHtml(conversation.status)}</span>
          </header>
          <div class="detail">${escapeHtml(
            `${formatCount(conversation.messageCount)} msgs • ${timer} • ${shortId(conversation.conversationId, 10)}`,
          )}</div>
          <div class="detail">${escapeHtml(
            conversation.lastMessagePreview || "No stored preview yet.",
          )}</div>
        </article>
      `;
    })
    .join("");
}

function renderSessions(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions)
    ? snapshot.sessions.slice(0, 8)
    : [];
  dom.sessionCountBadge.textContent = formatCount(sessions.length);

  if (!sessions.length) {
    dom.sessionList.innerHTML =
      '<div class="empty-state">No active session mappings right now.</div>';
    return;
  }

  dom.sessionList.innerHTML = sessions
    .map(
      (session) => `
        <article class="stack-item">
          <header>
            <strong>${escapeHtml(session.sessionIdShort)}</strong>
            <span class="status-pill" data-state="${escapeHtml(
              session.resumeFailures > 0 ? "warn" : "ready",
            )}">${escapeHtml(humanizeModel(session.model))}</span>
          </header>
          <div class="detail">${escapeHtml(
            `chat ${shortId(session.conversationId, 10)} • idle ${formatDuration(session.idleMs)} • age ${formatDuration(session.ageMs)}`,
          )}</div>
          <div class="detail">${escapeHtml(
            `ctx ${formatCount(session.contextTokens)} tok • tasks ${formatCount(session.taskCount)} • resume fails ${formatCount(session.resumeFailures)}`,
          )}</div>
        </article>
      `,
    )
    .join("");
}

function renderLogs() {
  const logs = state.logs.slice(-8).reverse();
  dom.logCountBadge.textContent = formatCount(state.logs.length);

  if (!logs.length) {
    dom.logList.innerHTML =
      '<div class="empty-state">No log entries in memory yet.</div>';
    return;
  }

  dom.logList.innerHTML = logs
    .map((entry) => {
      const summary = summarizeLog(entry);
      return `
        <article class="log-item">
          <header>
            <strong>${escapeHtml(summary.title)}</strong>
            <span class="status-pill" data-state="${escapeHtml(summary.state)}">${escapeHtml(summary.stamp)}</span>
          </header>
          <div class="detail">${escapeHtml(summary.detail)}</div>
        </article>
      `;
    })
    .join("");
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;

  dom.metricActiveRequests.textContent = formatCount(snapshot.runtime.activeRequests);
  dom.metricQueuedRequests.textContent = formatCount(snapshot.runtime.queuedRequests);
  dom.metricSessions.textContent = formatCount(snapshot.runtime.activeSessions);
  dom.metricSubprocesses.textContent = formatCount(snapshot.runtime.activeSubprocesses);
  dom.metricActiveRequestsNote.textContent =
    snapshot.runtime.activeRequests > 0
      ? `${formatCount(snapshot.runtime.activeRequests)} live lanes`
      : "runtime lanes";
  dom.metricQueuedRequestsNote.textContent =
    snapshot.queue.queuedRequests > 0
      ? `${formatDuration(snapshot.queue.oldestQueueWaitMs)} oldest wait`
      : "back pressure";
  dom.metricSessionsNote.textContent =
    `${formatCount(snapshot.failureStats.totalFailures)} resume failures tracked`;
  dom.metricSubprocessesNote.textContent =
    `${formatCount(snapshot.availability.available.length)} models up`;

  dom.runtimeStamp.textContent = `Last sync ${stamp(snapshot.generatedAt)}`;
  dom.runtimeRefreshStamp.textContent = `sync ${stamp(snapshot.generatedAt)}`;
  dom.heroSummary.textContent =
    snapshot.status === "ok"
      ? snapshot.queue.queuedRequests > 0
        ? `${formatCount(snapshot.queue.queuedRequests)} queued across ${formatCount(snapshot.queue.queuedConversations)} conversations`
        : "Route clear and command deck online"
      : "Runtime degraded";
  dom.footerSummary.textContent =
    `${snapshot.status.toUpperCase()} • util ${Math.round(snapshot.queue.utilizationRatio * 100)}% • auth failures ${formatCount(snapshot.consecutiveAuthFailures)}`;

  setStatusPill(
    dom.stackMode,
    state.connected ? "Live" : "Polling",
    state.connected ? "running" : "warn",
  );

  renderConversations(snapshot);
  renderSessions(snapshot);
  renderLogs();
  updateModelChoices(state.models);
}

function renderTranscript() {
  if (!state.lab.messages.length) {
    dom.labTranscript.innerHTML =
      '<div class="empty-state">No messages yet. Send a prompt to test the proxy.</div>';
    return;
  }

  dom.labTranscript.innerHTML = state.lab.messages
    .map(
      (message) => `
        <article class="message-card" data-role="${escapeHtml(message.role)}">
          <div class="message-head">
            <strong class="message-role" data-role="${escapeHtml(message.role)}">${escapeHtml(message.role)}</strong>
            <span class="meta-badge">${escapeHtml(message.meta || "lab")}</span>
          </div>
          <div class="message-body">${escapeHtml(message.content || "")}</div>
        </article>
      `,
    )
    .join("");

  requestAnimationFrame(() => {
    dom.labTranscript.scrollTop = dom.labTranscript.scrollHeight;
  });
}

function updateLabControls() {
  dom.labSendButton.disabled = state.lab.sending;
  dom.labStopButton.disabled = !state.lab.sending;
  dom.labModelSelect.disabled = state.lab.sending;
  dom.labModelInput.disabled = state.lab.sending;
  dom.labConversationInput.disabled = state.lab.sending;
  dom.labSystemInput.disabled = state.lab.sending;
  dom.labPromptInput.disabled = false;

  if (state.lab.sending) {
    setStatusPill(dom.labStatusPill, "Streaming", "streaming");
  } else {
    setStatusPill(dom.labStatusPill, "Ready", "ready");
  }
}

function renderLabRequestPreview(body) {
  dom.labRequestPreview.textContent = JSON.stringify(body, null, 2);
}

function resetLab() {
  state.lab.messages = [];
  state.lab.pendingMessageId = null;
  state.lab.conversationId = generateConversationId();
  dom.labConversationInput.value = state.lab.conversationId;
  dom.labPromptInput.value = "";
  dom.labRawOutput.textContent = "No response yet.";
  dom.labResponseStatus.textContent = "ready";
  dom.labResponseModel.textContent = "pending";
  dom.labResponseConversation.textContent = shortId(state.lab.conversationId, 16);
  dom.labLatencyBadge.textContent = "idle";
  setStatusPill(dom.labLatencyBadge, "idle", "ready");
  renderLabBadges();
  renderTranscript();
  renderLabRequestPreview({
    model: readCurrentModel(),
    messages: [],
  });
}

function buildLabMessages(userPrompt) {
  const messages = [];
  const systemPrompt = dom.labSystemInput.value.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  state.lab.messages.forEach((message) => {
    if (message.role === "error") return;
    messages.push({
      role: message.role === "system" ? "assistant" : message.role,
      content: message.content,
    });
  });
  messages.push({ role: "user", content: userPrompt });
  return messages;
}

function extractAssistantContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("");
  }

  return "";
}

async function parseErrorPayload(response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || JSON.stringify(payload);
  } catch {
    return response.statusText || `Request failed: ${response.status}`;
  }
}

async function consumeStream(response, assistantMessage) {
  if (!response.body) {
    throw new Error("Readable stream not available");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const rawEvents = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const lines = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s*/, "").trim())
        .filter(Boolean);

      for (const line of lines) {
        rawEvents.push(line);
        if (line === "[DONE]") {
          continue;
        }
        const payload = JSON.parse(line);
        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          assistantMessage.content += delta;
          renderTranscript();
        } else if (Array.isArray(delta)) {
          assistantMessage.content += delta
            .map((part) => {
              if (typeof part === "string") return part;
              if (typeof part?.text === "string") return part.text;
              return "";
            })
            .join("");
          renderTranscript();
        }
      }
    }
  }

  return rawEvents.join("\n");
}

async function sendLabRequest() {
  if (state.lab.sending) return;
  const userPrompt = dom.labPromptInput.value.trim();
  if (!userPrompt) return;

  const model = readCurrentModel();
  const conversationId = dom.labConversationInput.value.trim() || state.lab.conversationId;
  dom.labConversationInput.value = conversationId;
  state.lab.conversationId = conversationId;
  renderLabBadges();

  const requestBody = {
    model,
    stream: Boolean(dom.labStreamToggle.checked),
    user: conversationId,
    messages: buildLabMessages(userPrompt),
  };

  renderLabRequestPreview(requestBody);

  const userMessage = {
    id: makeMessageId(),
    role: "user",
    content: userPrompt,
    meta: stamp(new Date().toISOString()),
  };
  const assistantMessage = {
    id: makeMessageId(),
    role: "assistant",
    content: "",
    meta: requestBody.stream ? "streaming" : "waiting",
  };

  state.lab.messages.push(userMessage, assistantMessage);
  state.lab.pendingMessageId = assistantMessage.id;
  state.lab.sending = true;
  updateLabControls();
  renderTranscript();

  dom.labPromptInput.value = "";
  dom.labResponseConversation.textContent = shortId(conversationId, 16);
  dom.labResponseModel.textContent = humanizeModel(model);
  dom.labResponseStatus.textContent = requestBody.stream ? "streaming" : "pending";
  setStatusPill(dom.labStatusPill, requestBody.stream ? "Streaming" : "Running", "running");

  const controller = new AbortController();
  state.lab.controller = controller;
  const startedAt = performance.now();

  try {
    const response = await fetch(links.chatCompletions, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await parseErrorPayload(response));
    }

    let rawOutput = "";
    if (requestBody.stream) {
      rawOutput = await consumeStream(response, assistantMessage);
    } else {
      const payload = await response.json();
      assistantMessage.content = extractAssistantContent(payload) || "";
      rawOutput = JSON.stringify(payload, null, 2);
      dom.labResponseModel.textContent = humanizeModel(payload?.model || model);
    }

    assistantMessage.meta = "assistant";
    renderTranscript();

    const elapsed = performance.now() - startedAt;
    setStatusPill(dom.labStatusPill, "Success", "ok");
    setStatusPill(dom.labLatencyBadge, formatDuration(elapsed), "ready");
    dom.labResponseStatus.textContent = "success";
    dom.labRawOutput.textContent = rawOutput || "No body returned.";
  } catch (error) {
    assistantMessage.role = "error";
    assistantMessage.content = error instanceof Error ? error.message : String(error);
    assistantMessage.meta = "error";
    renderTranscript();

    setStatusPill(dom.labStatusPill, "Error", "error");
    setStatusPill(dom.labLatencyBadge, "failed", "error");
    dom.labResponseStatus.textContent = "error";
    dom.labRawOutput.textContent = assistantMessage.content;
  } finally {
    state.lab.pendingMessageId = null;
    state.lab.sending = false;
    state.lab.controller = null;
    updateLabControls();
  }
}

function stopLabRequest() {
  if (state.lab.controller) {
    state.lab.controller.abort();
  }
}

function pushLiveLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_LOGS);
  }
  renderLogs();
}

function connectStream() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const source = new EventSource("/ops/stream");
  state.eventSource = source;

  source.addEventListener("open", () => {
    state.connected = true;
    applySnapshot(state.snapshot);
  });

  source.addEventListener("snapshot", (event) => {
    state.connected = true;
    const snapshot = JSON.parse(event.data);
    applySnapshot(snapshot);
  });

  source.addEventListener("log", (event) => {
    pushLiveLog(JSON.parse(event.data));
  });

  source.addEventListener("error", () => {
    state.connected = false;
    applySnapshot(state.snapshot);
  });
}

function installEvents() {
  dom.labModelSelect.addEventListener("change", renderLabBadges);
  dom.labModelInput.addEventListener("input", renderLabBadges);
  dom.labConversationInput.addEventListener("input", renderLabBadges);
  dom.labSendButton.addEventListener("click", () => {
    void sendLabRequest();
  });
  dom.labStopButton.addEventListener("click", stopLabRequest);
  dom.labResetButton.addEventListener("click", resetLab);
  dom.labPromptInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void sendLabRequest();
    }
  });
}

function bootstrap() {
  setLinks();
  dom.labConversationInput.value = state.lab.conversationId;
  updateLabControls();
  updateModelChoices([]);
  applySnapshot(initialSnapshot);
  resetLab();
  installEvents();
  void fetchModels();
  connectStream();
}

bootstrap();
