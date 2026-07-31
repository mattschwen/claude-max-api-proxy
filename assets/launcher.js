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
  modelCatalog: {
    loading: true,
    error: null,
  },
  capabilities: null,
  connected: false,
  lab: {
    threads: new Map(),
    currentThreadId: null,
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
  labThreadSummary: document.getElementById("labThreadSummary"),
  labThreadList: document.getElementById("labThreadList"),
  labNewThreadButton: document.getElementById("labNewThreadButton"),
  labBranchThreadButton: document.getElementById("labBranchThreadButton"),
  labModelSelect: document.getElementById("labModelSelect"),
  labModelInput: document.getElementById("labModelInput"),
  labModelHelp: document.getElementById("labModelHelp"),
  labConversationInput: document.getElementById("labConversationInput"),
  labPolicySelect: document.getElementById("labPolicySelect"),
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
  labComposerHint: document.getElementById("labComposerHint"),
  labAnnouncement: document.getElementById("labAnnouncement"),
};

class LabRequestError extends Error {
  constructor(message, code = null, status = null) {
    super(message);
    this.name = "LabRequestError";
    this.code = code;
    this.status = status;
  }
}

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
  return `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeMessageId() {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeThread(conversationId = generateConversationId(), options = {}) {
  return {
    id: conversationId,
    conversationId,
    title: options.title || "New thread",
    messages: Array.isArray(options.messages) ? options.messages : [],
    requests: new Map(),
    model: options.model || "default",
    customModel: options.customModel || "",
    systemPrompt: options.systemPrompt || "",
    draft: options.draft || "",
    stream: options.stream ?? true,
    policy:
      options.policy ||
      (state.snapshot?.config?.sameConversationPolicy === "queue"
        ? "queue"
        : "interrupt"),
    loading: false,
    loadError: null,
    inspector: {
      status: "ready",
      model: options.model || "pending",
      conversationId,
      latency: "idle",
      latencyState: "ready",
      requestPreview: {
        model: options.model || "default",
        messages: [],
      },
      rawOutput: "No response yet.",
    },
  };
}

function getCurrentThread() {
  return state.lab.currentThreadId
    ? state.lab.threads.get(state.lab.currentThreadId) || null
    : null;
}

function getActiveRequests(thread) {
  if (!thread) return [];
  return Array.from(thread.requests.values()).filter((request) =>
    ["queued", "running", "superseding", "stopping"].includes(request.status),
  );
}

function getThreadStatus(thread) {
  const active = getActiveRequests(thread);
  if (active.some((request) => request.status === "running")) return "running";
  if (active.some((request) => request.status === "superseding")) return "interrupting";
  if (active.some((request) => request.status === "stopping")) return "stopping";
  if (active.length) return "queued";
  return thread?.inspector?.status || "ready";
}

function titleFromMessages(messages) {
  const firstUser = messages.find(
    (message) => message.role === "user" && String(message.content || "").trim(),
  );
  if (!firstUser) return "New thread";
  const compact = String(firstUser.content).replace(/\s+/g, " ").trim();
  return compact.length > 42 ? `${compact.slice(0, 41)}…` : compact;
}

function announce(message) {
  dom.labAnnouncement.textContent = "";
  requestAnimationFrame(() => {
    dom.labAnnouncement.textContent = message;
  });
}

function saveCurrentThreadControls() {
  const thread = getCurrentThread();
  if (!thread) return;
  thread.conversationId = dom.labConversationInput.value.trim() || thread.id;
  thread.model = dom.labModelSelect.value || "default";
  thread.customModel = dom.labModelInput.value.trim();
  thread.systemPrompt = dom.labSystemInput.value;
  thread.draft = dom.labPromptInput.value;
  thread.stream = Boolean(dom.labStreamToggle.checked);
  thread.policy = dom.labPolicySelect.value === "queue"
    ? "queue"
    : "interrupt";
}

function loadThreadControls(thread) {
  dom.labConversationInput.value = thread.conversationId;
  dom.labModelInput.value = thread.customModel;
  const desiredModel = thread.model || "default";
  if (Array.from(dom.labModelSelect.options).some((option) => option.value === desiredModel)) {
    dom.labModelSelect.value = desiredModel;
  } else if (desiredModel && !thread.customModel) {
    dom.labModelInput.value = desiredModel;
    thread.customModel = desiredModel;
  }
  dom.labSystemInput.value = thread.systemPrompt;
  dom.labPromptInput.value = thread.draft;
  dom.labStreamToggle.checked = thread.stream;
  dom.labPolicySelect.value = thread.policy === "queue"
    ? "queue"
    : "interrupt";
}

function createThread(options = {}) {
  const thread = makeThread(options.conversationId, options);
  state.lab.threads.set(thread.id, thread);
  return thread;
}

function switchThread(threadId) {
  const next = state.lab.threads.get(threadId);
  if (!next) return;
  saveCurrentThreadControls();
  state.lab.currentThreadId = threadId;
  loadThreadControls(next);
  renderLab();
  dom.labPromptInput.focus();
}

function createAndSwitchThread(options = {}) {
  const thread = createThread(options);
  switchThread(thread.id);
  return thread;
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

  const add = (value, details = {}) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    models.push({
      id: normalized,
      ownedBy: details.ownedBy || (
        normalized.startsWith("gemini-")
          ? "google"
          : normalized.startsWith("glm-")
            ? "zai"
            : "anthropic"
      ),
      available: details.available !== false,
      availability:
        details.availability || (details.available === false ? "unavailable" : "available"),
      message: details.message || "",
      family: details.family || "",
      capabilities: details.capabilities || null,
    });
  };

  add("default", { ownedBy: "alias", family: "alias" });

  (snapshot?.availability?.available || []).forEach((entry) =>
    add(entry.id, {
      ownedBy: "anthropic",
      family: entry.family,
      available: true,
      availability: "available",
    }));
  (snapshot?.config?.externalProviders || []).forEach((provider) => {
    add(provider.model, {
      ownedBy: provider.provider,
      family: provider.transport,
      available: true,
      availability: "configured",
    });
    (provider.extraModels || []).forEach((model) =>
      add(model, {
        ownedBy: provider.provider,
        family: provider.transport,
        available: true,
        availability: "configured",
      }));
  });
  (snapshot?.recentConversations || []).forEach((entry) =>
    add(entry.model, { available: true }));
  (snapshot?.availability?.unavailable || []).forEach((entry) =>
    add(entry.id, {
      ownedBy: "anthropic",
      family: entry.family,
      available: false,
      availability: "unavailable",
      message: entry.message,
    }));

  return models;
}

function normalizeModelEntries(models) {
  return (models || [])
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          id: entry,
          ownedBy: "unknown",
          available: true,
          availability: "available",
          message: "",
          capabilities: null,
        };
      }
      const availability = String(
        entry?.availability || (entry?.available === false ? "unavailable" : "available"),
      );
      return {
        id: String(entry?.id || "").trim(),
        ownedBy: String(entry?.ownedBy || entry?.owned_by || "unknown"),
        available: entry?.available !== false && availability !== "unavailable",
        availability,
        message: String(entry?.message || ""),
        family: String(entry?.family || ""),
        capabilities: entry?.capabilities || null,
      };
    })
    .filter((entry) => entry.id);
}

function providerLabel(value) {
  const provider = String(value || "").toLowerCase();
  if (provider === "anthropic") return "Claude";
  if (provider === "google" || provider === "gemini-cli") return "Gemini";
  if (provider === "zai") return "Z.AI / GLM";
  if (provider === "alias") return "Routing";
  return provider ? provider.replace(/[-_]/g, " ") : "Other";
}

function updateModelChoices(models) {
  const current = readCurrentModel();
  const supplied = normalizeModelEntries(models);
  const choices = supplied.length
    ? supplied
    : collectSuggestedModels(state.snapshot);
  if (!choices.some((entry) => entry.id === "default")) {
    choices.unshift({
      id: "default",
      ownedBy: "alias",
      available: true,
      availability: "available",
      message: "",
      family: "alias",
      capabilities: null,
    });
  }
  state.models = choices;

  const groups = new Map();
  choices.forEach((model) => {
    const key = model.id === "default" ? "Routing" : providerLabel(model.ownedBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  });
  dom.labModelSelect.innerHTML = Array.from(groups.entries())
    .map(([label, entries]) => `
      <optgroup label="${escapeHtml(label)}">
        ${entries
          .map(
            (model) => `
              <option
                value="${escapeHtml(model.id)}"
                ${model.available ? "" : "disabled"}
              >${escapeHtml(humanizeModel(model.id))}${
                model.availability === "configured"
                  ? " — configured"
                  : model.available
                    ? ""
                    : " — unavailable"
              }</option>
            `,
          )
          .join("")}
      </optgroup>
    `)
    .join("");

  if (choices.some((entry) => entry.id === current && entry.available)) {
    dom.labModelSelect.value = current;
  } else {
    dom.labModelSelect.value = "default";
  }

  renderLabBadges();
  renderModelHelp();
}

async function fetchModels() {
  state.modelCatalog.loading = true;
  state.modelCatalog.error = null;
  renderModelHelp();
  try {
    const capabilitiesRequest = fetch(links.capabilities, {
      headers: { accept: "application/json" },
      cache: "no-store",
    }).catch(() => null);
    const modelResponse = await fetch(links.models, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!modelResponse.ok) {
      throw new Error(`Model catalog returned ${modelResponse.status}`);
    }
    const payload = await modelResponse.json();
    const capabilitiesResponse = await capabilitiesRequest;
    state.capabilities = capabilitiesResponse?.ok
      ? await capabilitiesResponse.json()
      : null;
    const modelMap = new Map(
      (Array.isArray(payload?.data) ? payload.data : [])
        .filter((entry) => entry?.id)
        .map((entry) => [
          entry.id,
          {
            id: entry.id,
            ownedBy: entry.owned_by,
            available: true,
            availability: "available",
          },
        ]),
    );
    (Array.isArray(state.capabilities?.models?.catalog)
      ? state.capabilities.models.catalog
      : []
    ).forEach((entry) => {
      if (!entry?.id) return;
      const availability = String(entry.availability || "configured");
      const errorMessage =
        typeof entry.error === "string"
          ? entry.error
          : String(entry.error?.message || "");
      modelMap.set(entry.id, {
        ...(modelMap.get(entry.id) || {}),
        id: entry.id,
        ownedBy: entry.provider,
        family: entry.transport,
        availability,
        available: availability !== "unavailable",
        message: errorMessage,
        capabilities: entry.capabilities || null,
      });
    });
    (Array.isArray(state.capabilities?.models?.acceptedSelectors)
      ? state.capabilities.models.acceptedSelectors
      : []
    ).forEach((selector) => {
      const id = String(selector || "").trim();
      if (!id || modelMap.has(id)) return;
      modelMap.set(id, {
        id,
        ownedBy: "alias",
        family: "selector",
        availability: "selector",
        available: true,
        message: id.endsWith("[1m]")
          ? "Claude Code validates extended-context access when sent."
          : "",
        capabilities: null,
      });
    });
    const models = Array.from(modelMap.values());
    state.modelCatalog.loading = false;
    updateModelChoices(models);
  } catch (error) {
    state.modelCatalog.loading = false;
    state.modelCatalog.error = error instanceof Error ? error.message : String(error);
    updateModelChoices([]);
  }
}

function renderLabBadges() {
  dom.labConversationBadge.textContent = shortId(dom.labConversationInput.value.trim(), 16);
  dom.labModelBadge.textContent = humanizeModel(readCurrentModel());
}

function renderModelHelp() {
  if (state.modelCatalog.loading) {
    dom.labModelHelp.textContent = "Loading model and capability catalog…";
    dom.labModelHelp.dataset.state = "loading";
    return;
  }
  if (state.modelCatalog.error) {
    dom.labModelHelp.textContent =
      `Live model catalog unavailable (${state.modelCatalog.error}). Showing the latest runtime snapshot.`;
    dom.labModelHelp.dataset.state = "error";
    return;
  }

  const selectedId = readCurrentModel();
  const selected = state.models.find((entry) => entry.id === selectedId);
  const custom = dom.labModelInput.value.trim();
  if (custom) {
    dom.labModelHelp.textContent =
      `Custom exact model “${custom}” overrides the catalog selection. The proxy will validate it when sent.`;
    dom.labModelHelp.dataset.state = "warn";
    return;
  }
  if (!selected) {
    dom.labModelHelp.textContent = "Choose an available model or enter an exact custom ID.";
    dom.labModelHelp.dataset.state = "warn";
    return;
  }
  if (selected.id === "default") {
    dom.labModelHelp.textContent =
      "Default keeps the request on Claude and follows Claude Code’s account-tier recommendation.";
    dom.labModelHelp.dataset.state = "ready";
    return;
  }

  const adaptive =
    selected.capabilities?.adaptiveReasoning === true ||
    (
      Array.isArray(state.capabilities?.reasoning?.adaptiveModels) &&
      state.capabilities.reasoning.adaptiveModels.includes(selected.id)
    );
  const availability = selected.availability || (
    selected.available ? "available" : "unavailable"
  );
  dom.labModelHelp.textContent =
    `${providerLabel(selected.ownedBy)} · ${availability}${availability === "configured" ? " (not health-checked)" : ""}${adaptive ? " · adaptive reasoning" : ""}${selected.message ? ` · ${selected.message}` : ""}`;
  dom.labModelHelp.dataset.state =
    availability === "unavailable"
      ? "error"
      : availability === "configured"
        ? "warn"
        : "ready";
}

function renderLabThreadList() {
  const threads = Array.from(state.lab.threads.values());
  const focusedThreadId =
    document.activeElement?.closest?.("[data-thread-id]")?.getAttribute(
      "data-thread-id",
    ) || null;
  dom.labThreadSummary.textContent =
    `${formatCount(threads.length)} local thread${threads.length === 1 ? "" : "s"}`;

  dom.labThreadList.innerHTML = threads
    .map((thread) => {
      const selected = thread.id === state.lab.currentThreadId;
      const status = getThreadStatus(thread);
      return `
        <button
          class="thread-tab${selected ? " is-selected" : ""}"
          type="button"
          role="tab"
          aria-selected="${selected ? "true" : "false"}"
          tabindex="${selected ? "0" : "-1"}"
          data-thread-id="${escapeHtml(thread.id)}"
          data-state="${escapeHtml(status)}"
        >
          <span class="thread-tab-title">${escapeHtml(thread.title)}</span>
          <span class="thread-tab-meta">
            ${escapeHtml(shortId(thread.conversationId, 12))} · ${escapeHtml(status)}
          </span>
        </button>
      `;
    })
    .join("");

  dom.labThreadList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      switchThread(button.getAttribute("data-thread-id"));
    });
  });
  if (focusedThreadId) {
    dom.labThreadList
      .querySelector(`[data-thread-id="${CSS.escape(focusedThreadId)}"]`)
      ?.focus({ preventScroll: true });
  }
}

function renderInspector() {
  const thread = getCurrentThread();
  if (!thread) return;
  const inspector = thread.inspector;
  dom.labResponseStatus.textContent = inspector.status;
  dom.labResponseModel.textContent = humanizeModel(inspector.model);
  dom.labResponseConversation.textContent = shortId(
    inspector.conversationId || thread.conversationId,
    16,
  );
  setStatusPill(
    dom.labLatencyBadge,
    inspector.latency,
    inspector.latencyState || "ready",
  );
  dom.labRawOutput.textContent = inspector.rawOutput || "No response yet.";
  renderLabRequestPreview(inspector.requestPreview || {
    model: readCurrentModel(),
    messages: [],
  });
}

function renderLab() {
  renderLabThreadList();
  renderLabBadges();
  renderModelHelp();
  renderTranscript();
  renderInspector();
  updateLabControls();
}

function addNewThread() {
  saveCurrentThreadControls();
  const current = getCurrentThread();
  createAndSwitchThread({
    model: current?.model || "default",
    customModel: current?.customModel || "",
    systemPrompt: current?.systemPrompt || "",
    stream: current?.stream ?? true,
    policy: current?.policy,
  });
  announce("New independent thread created.");
}

function branchCurrentThread() {
  saveCurrentThreadControls();
  const current = getCurrentThread();
  if (!current) return;
  const messages = current.messages
    .filter(
      (message) =>
        (message.role === "user" && message.status === "complete") ||
        (message.role === "assistant" && message.status === "complete"),
    )
    .map((message) => ({
      ...message,
      id: makeMessageId(),
      requestId: undefined,
      meta: message.meta || "history",
      status: "complete",
    }));
  const thread = createAndSwitchThread({
    title: `Branch · ${current.title}`,
    messages,
    model: current.model,
    customModel: current.customModel,
    systemPrompt: current.systemPrompt,
    stream: current.stream,
    policy: current.policy,
  });
  thread.inspector.status = "ready";
  thread.inspector.rawOutput =
    "Branched locally. The first send will create a new proxy conversation with this transcript.";
  renderLab();
  announce(`Branched ${current.title} into a new conversation.`);
}

async function resumeStoredConversation(conversationId, options = {}) {
  if (!conversationId) return;
  const existing = Array.from(state.lab.threads.values()).find(
    (thread) => thread.conversationId === conversationId,
  );
  if (existing && !options.force) {
    switchThread(existing.id);
    announce(`Switched to ${existing.title}.`);
    return;
  }

  const thread = existing || createThread({
    conversationId,
    title: `Conversation ${shortId(conversationId, 10)}`,
  });
  thread.loading = true;
  thread.loadError = null;
  switchThread(thread.id);

  try {
    const response = await fetch(
      `/ops/conversations/${encodeURIComponent(conversationId)}?limit=64`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(`Transcript returned ${response.status}`);
    }
    const detail = await response.json();
    thread.messages = Array.isArray(detail?.messages)
      ? detail.messages.map((message) => ({
          id: makeMessageId(),
          role: message.role || "assistant",
          content: String(message.content || ""),
          meta: message.created_at
            ? stamp(new Date(message.created_at).toISOString())
            : "stored",
          status: "complete",
        }))
      : [];
    thread.title = titleFromMessages(thread.messages);
    const storedModel = detail?.conversation?.model;
    if (storedModel) {
      if (state.models.some((model) => model.id === storedModel && model.available)) {
        thread.model = storedModel;
        thread.customModel = "";
      } else {
        thread.customModel = storedModel;
      }
    }
    thread.inspector = {
      status: "resumed",
      model: storedModel || thread.model,
      conversationId,
      latency: "stored",
      latencyState: "ready",
      requestPreview: {
        model: storedModel || thread.model,
        conversation_id: conversationId,
        messages: thread.messages.map(({ role, content }) => ({ role, content })),
      },
      rawOutput: `Loaded ${thread.messages.length} stored messages from the operator snapshot.`,
    };
    thread.loading = false;
    if (state.lab.currentThreadId === thread.id) {
      loadThreadControls(thread);
      renderLab();
    } else {
      renderLabThreadList();
    }
    announce(`Resumed ${thread.title}.`);
  } catch (error) {
    thread.loading = false;
    thread.loadError = error instanceof Error ? error.message : String(error);
    renderLab();
    announce(`Could not resume conversation: ${thread.loadError}`);
  }
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
        <div class="stack-list-item" role="listitem">
          <button
            class="stack-item stack-item--interactive"
            type="button"
            data-conversation-id="${escapeHtml(conversation.conversationId)}"
            aria-label="Resume conversation ${escapeHtml(shortId(conversation.conversationId, 10))}"
          >
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
            <div class="resume-label">Open in Chat Lab →</div>
          </button>
        </div>
      `;
    })
    .join("");

  dom.conversationList
    .querySelectorAll("[data-conversation-id]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        void resumeStoredConversation(button.getAttribute("data-conversation-id"));
      });
    });
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
  if (state.modelCatalog.error || !state.models.length) {
    updateModelChoices([]);
  }
  renderLabThreadList();
  renderLabBadges();
  renderModelHelp();
  updateLabControls();
}

function renderTranscript() {
  const thread = getCurrentThread();
  if (!thread) {
    dom.labTranscript.innerHTML =
      '<div class="empty-state">Create a thread to start testing the proxy.</div>';
    return;
  }
  if (thread.loading) {
    dom.labTranscript.innerHTML =
      '<div class="empty-state" data-state="loading">Loading stored conversation…</div>';
    return;
  }
  if (thread.loadError) {
    dom.labTranscript.innerHTML = `
      <div class="empty-state" data-state="error">
        <strong>Could not load this conversation.</strong>
        <span>${escapeHtml(thread.loadError)}</span>
        <button class="button button--compact" id="labRetryResumeButton" type="button">Retry</button>
      </div>
    `;
    document.getElementById("labRetryResumeButton")?.addEventListener("click", () => {
      void resumeStoredConversation(thread.conversationId, { force: true });
    });
    return;
  }
  if (!thread.messages.length) {
    dom.labTranscript.innerHTML =
      '<div class="empty-state">No messages yet. Send a prompt to test the proxy.</div>';
    return;
  }

  dom.labTranscript.innerHTML = thread.messages
    .map(
      (message) => `
        <article
          class="message-card"
          data-role="${escapeHtml(message.role)}"
          data-status="${escapeHtml(message.status || "complete")}"
        >
          <div class="message-head">
            <strong class="message-role" data-role="${escapeHtml(message.role)}">${escapeHtml(message.role)}</strong>
            <span class="meta-badge" data-state="${escapeHtml(message.status || "ready")}">${escapeHtml(message.meta || "lab")}</span>
          </div>
          <div class="message-body">${escapeHtml(
            message.content ||
              (message.status === "queued"
                ? "Waiting for the active turn to finish…"
                : message.status === "running"
                  ? "Waiting for the first token…"
                  : message.status === "interrupted"
                    ? "Interrupted before any text was returned."
                    : ""),
          )}</div>
        </article>
      `,
    )
    .join("");

  requestAnimationFrame(() => {
    dom.labTranscript.scrollTop = dom.labTranscript.scrollHeight;
  });
}

function updateLabControls() {
  const thread = getCurrentThread();
  const active = getActiveRequests(thread);
  const status = getThreadStatus(thread);
  dom.labSendButton.disabled = !thread || thread.loading;
  dom.labStopButton.disabled = active.length === 0;
  dom.labResetButton.disabled = active.length > 0 || !thread;
  dom.labBranchThreadButton.disabled = !thread || thread.loading;
  dom.labPromptInput.disabled = !thread || thread.loading;
  dom.labConversationInput.disabled =
    !thread || thread.loading || active.length > 0;

  const statusLabels = {
    running: ["Running", "running"],
    queued: ["Queued", "warn"],
    interrupting: ["Interrupting", "warn"],
    stopping: ["Stopping", "warn"],
    interrupted: ["Interrupted", "warn"],
    stopped: ["Stopped", "warn"],
    error: ["Error", "error"],
    success: ["Complete", "ok"],
    resumed: ["Resumed", "ready"],
    ready: ["Ready", "ready"],
  };
  const [label, stateName] = statusLabels[status] || ["Ready", "ready"];
  setStatusPill(dom.labStatusPill, label, stateName);

  const policy = thread?.policy === "queue" ? "queue" : "interrupt";
  dom.labComposerHint.textContent =
    policy === "queue"
      ? "New prompts in this thread wait in order. Different threads run independently."
      : "New prompts interrupt the active response in this thread. Different threads run independently.";
}

function renderLabRequestPreview(body) {
  dom.labRequestPreview.textContent = JSON.stringify(body, null, 2);
}

function resetLab() {
  const current = getCurrentThread();
  if (!current || getActiveRequests(current).length) return;
  state.lab.threads.delete(current.id);
  createAndSwitchThread({
    model: current.model,
    customModel: current.customModel,
    systemPrompt: current.systemPrompt,
    stream: current.stream,
    policy: current.policy,
  });
  announce("Current thread reset with a new conversation id.");
}

function buildLabMessages(thread, userPrompt) {
  const messages = [];
  const systemPrompt = thread.systemPrompt.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  thread.messages.forEach((message) => {
    if (message.role === "error") return;
    if (
      message.role === "user" &&
      message.status &&
      message.status !== "complete"
    ) {
      return;
    }
    if (
      message.role === "assistant" &&
      message.status &&
      message.status !== "complete"
    ) {
      return;
    }
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
    return new LabRequestError(
      payload?.error?.message || JSON.stringify(payload),
      payload?.error?.code ?? null,
      response.status,
    );
  } catch {
    return new LabRequestError(
      response.statusText || `Request failed: ${response.status}`,
      null,
      response.status,
    );
  }
}

function renderRequestUpdate(thread) {
  if (state.lab.currentThreadId === thread.id) {
    renderLab();
  } else {
    renderLabThreadList();
  }
}

function processStreamPayload(payload, thread, request, assistantMessage) {
  if (payload?.error) {
    throw new LabRequestError(
      payload.error.message || "The proxy returned a streaming error.",
      payload.error.code ?? null,
      payload.error.status ?? null,
    );
  }
  if (payload?.model) {
    request.servedModel = payload.model;
    if (thread.latestRequestId === request.id) {
      thread.inspector.model = payload.model;
    }
  }
  const delta = payload?.choices?.[0]?.delta?.content;
  if (typeof delta === "string") {
    assistantMessage.content += delta;
  } else if (Array.isArray(delta)) {
    assistantMessage.content += delta
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (assistantMessage.content) {
    assistantMessage.status = "running";
    assistantMessage.meta = "streaming";
  }
  renderRequestUpdate(thread);
}

async function consumeStream(response, thread, request, assistantMessage) {
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

    let boundary = /\r?\n\r?\n/.exec(buffer);
    while (boundary) {
      const chunk = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/.exec(buffer);

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
        processStreamPayload(payload, thread, request, assistantMessage);
      }
    }
  }

  const trailingLines = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s*/, "").trim())
    .filter(Boolean);
  for (const line of trailingLines) {
    rawEvents.push(line);
    if (line !== "[DONE]") {
      processStreamPayload(
        JSON.parse(line),
        thread,
        request,
        assistantMessage,
      );
    }
  }

  return rawEvents.join("\n");
}

async function sendLabRequest() {
  const thread = getCurrentThread();
  if (!thread || thread.loading) return;
  const userPrompt = dom.labPromptInput.value.trim();
  if (!userPrompt) {
    announce("Enter a prompt before sending.");
    dom.labPromptInput.focus();
    return;
  }

  saveCurrentThreadControls();

  const model = readCurrentModel();
  const conversationId = thread.conversationId || generateConversationId();
  dom.labConversationInput.value = conversationId;
  renderLabBadges();

  const existingRequests = getActiveRequests(thread);
  const policy = thread.policy === "queue" ? "queue" : "interrupt";
  if (existingRequests.length && policy === "interrupt") {
    existingRequests.forEach((existing) => {
      existing.status = "superseding";
      existing.userMessage.status = "interrupted";
      existing.userMessage.meta = "interrupting";
      existing.assistantMessage.status = "interrupted";
      existing.assistantMessage.meta = "interrupting";
    });
  }

  const requestBody = {
    model,
    stream: thread.stream,
    conversation_id: conversationId,
    conversation_policy: policy,
    messages: buildLabMessages(thread, userPrompt),
  };

  const requestId = makeMessageId();
  const startsQueued = existingRequests.length > 0 && policy === "queue";
  const userMessage = {
    id: makeMessageId(),
    requestId,
    role: "user",
    content: userPrompt,
    meta: startsQueued ? "queued" : "sending",
    status: startsQueued ? "queued" : "running",
  };
  const assistantMessage = {
    id: makeMessageId(),
    requestId,
    role: "assistant",
    content: "",
    meta: startsQueued ? "queued" : requestBody.stream ? "streaming" : "waiting",
    status: startsQueued ? "queued" : "running",
  };

  thread.messages.push(userMessage, assistantMessage);
  thread.title = titleFromMessages(thread.messages);
  thread.draft = "";
  dom.labPromptInput.value = "";

  const controller = new AbortController();
  const startedAt = performance.now();
  const request = {
    id: requestId,
    controller,
    userMessage,
    assistantMessage,
    status: startsQueued ? "queued" : "running",
    startedAt,
    requestedModel: model,
    servedModel: model,
    stream: requestBody.stream,
  };
  thread.requests.set(requestId, request);
  thread.latestRequestId = requestId;
  thread.inspector = {
    status: startsQueued ? "queued" : requestBody.stream ? "streaming" : "running",
    model,
    conversationId,
    latency: startsQueued ? "queued" : "running",
    latencyState: startsQueued ? "warn" : "running",
    requestPreview: requestBody,
    rawOutput: startsQueued
      ? "Request accepted locally and waiting behind the active turn."
      : "Waiting for proxy response…",
  };
  renderRequestUpdate(thread);
  announce(
    startsQueued
      ? `Prompt queued in ${thread.title}.`
      : existingRequests.length
        ? `New prompt sent. The previous response is being interrupted.`
        : `Prompt sent in ${thread.title}.`,
  );

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
      throw await parseErrorPayload(response);
    }
    request.status = "running";
    assistantMessage.status = "running";
    assistantMessage.meta = requestBody.stream ? "streaming" : "running";
    if (thread.latestRequestId === request.id) {
      thread.inspector.status = requestBody.stream ? "streaming" : "running";
      thread.inspector.latency = "running";
      thread.inspector.latencyState = "running";
    }
    renderRequestUpdate(thread);

    let rawOutput = "";
    if (requestBody.stream) {
      rawOutput = await consumeStream(
        response,
        thread,
        request,
        assistantMessage,
      );
    } else {
      const payload = await response.json();
      if (payload?.error) {
        throw new LabRequestError(
          payload.error.message || "The proxy returned an error.",
          payload.error.code ?? null,
          response.status,
        );
      }
      assistantMessage.content = extractAssistantContent(payload) || "";
      rawOutput = JSON.stringify(payload, null, 2);
      request.servedModel = payload?.model || model;
    }

    assistantMessage.meta = "assistant";
    assistantMessage.status = "complete";
    userMessage.meta = "sent";
    userMessage.status = "complete";
    request.status = "success";

    const elapsed = performance.now() - startedAt;
    if (thread.latestRequestId === request.id) {
      thread.inspector = {
        status: "success",
        model: request.servedModel,
        conversationId,
        latency: formatDuration(elapsed),
        latencyState: "ready",
        requestPreview: requestBody,
        rawOutput: rawOutput || "No body returned.",
      };
    }
    announce(`Response completed in ${formatDuration(elapsed)}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isManualStop =
      controller.signal.aborted &&
      controller.signal.reason === "user_stopped";
    const isSuperseded =
      error instanceof LabRequestError &&
      error.code === "request_superseded";
    const terminalStatus = isManualStop
      ? "stopped"
      : isSuperseded
        ? "interrupted"
        : "error";
    request.status = terminalStatus;
    userMessage.status = terminalStatus;
    userMessage.meta = terminalStatus;
    assistantMessage.status = terminalStatus;
    assistantMessage.meta = terminalStatus;
    if (terminalStatus === "error") {
      assistantMessage.role = "error";
      assistantMessage.content = message;
    }

    if (thread.latestRequestId === request.id) {
      thread.inspector = {
        status: terminalStatus,
        model: request.servedModel || model,
        conversationId,
        latency: terminalStatus === "error" ? "failed" : terminalStatus,
        latencyState: terminalStatus === "error" ? "error" : "warn",
        requestPreview: requestBody,
        rawOutput:
          terminalStatus === "interrupted"
            ? `Interrupted by a newer message.${assistantMessage.content ? " Partial text remains in the transcript." : ""}`
            : terminalStatus === "stopped"
              ? `Stopped by the operator.${assistantMessage.content ? " Partial text remains in the transcript." : ""}`
              : message,
      };
    }
    announce(
      terminalStatus === "interrupted"
        ? "Previous response interrupted by the newer message."
        : terminalStatus === "stopped"
          ? "Current thread stopped."
          : `Request failed: ${message}`,
    );
  } finally {
    request.controller = null;
    thread.requests.delete(request.id);
    renderRequestUpdate(thread);
  }
}

function stopLabRequest() {
  const thread = getCurrentThread();
  const active = getActiveRequests(thread);
  if (!thread || !active.length) return;
  active.forEach((request) => {
    request.status = "stopping";
    request.userMessage.status = "stopping";
    request.userMessage.meta = "stopping";
    request.assistantMessage.status = "stopping";
    request.assistantMessage.meta = "stopping";
    request.controller?.abort("user_stopped");
  });
  renderRequestUpdate(thread);
  announce(
    active.length === 1
      ? "Stopping the current request."
      : `Stopping ${active.length} requests in this thread.`,
  );
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
    try {
      const snapshot = JSON.parse(event.data);
      applySnapshot(snapshot);
    } catch {
      state.connected = false;
      setStatusPill(dom.stackMode, "Stale", "warn");
    }
  });

  source.addEventListener("log", (event) => {
    try {
      pushLiveLog(JSON.parse(event.data));
    } catch {
      /* keep the live link open when one event is malformed */
    }
  });

  source.addEventListener("error", () => {
    state.connected = false;
    applySnapshot(state.snapshot);
  });
}

function installEvents() {
  dom.labModelSelect.addEventListener("change", () => {
    const thread = getCurrentThread();
    if (thread) thread.model = dom.labModelSelect.value;
    renderLabBadges();
    renderModelHelp();
  });
  dom.labModelInput.addEventListener("input", () => {
    const thread = getCurrentThread();
    if (thread) thread.customModel = dom.labModelInput.value.trim();
    renderLabBadges();
    renderModelHelp();
  });
  dom.labConversationInput.addEventListener("input", () => {
    const thread = getCurrentThread();
    if (thread) {
      thread.conversationId =
        dom.labConversationInput.value.trim() || thread.conversationId;
    }
    renderLabBadges();
    renderLabThreadList();
  });
  dom.labPolicySelect.addEventListener("change", () => {
    const thread = getCurrentThread();
    if (thread) {
      thread.policy = dom.labPolicySelect.value === "queue"
        ? "queue"
        : "interrupt";
    }
    updateLabControls();
  });
  dom.labNewThreadButton.addEventListener("click", addNewThread);
  dom.labBranchThreadButton.addEventListener("click", branchCurrentThread);
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
  dom.labPromptInput.addEventListener("input", () => {
    const thread = getCurrentThread();
    if (thread) thread.draft = dom.labPromptInput.value;
  });
  dom.labThreadList.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tabs = Array.from(dom.labThreadList.querySelectorAll('[role="tab"]'));
    const currentIndex = tabs.indexOf(document.activeElement);
    if (currentIndex < 0 || !tabs.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(currentIndex + delta + tabs.length) % tabs.length];
    const nextThreadId = next.getAttribute("data-thread-id");
    switchThread(nextThreadId);
    dom.labThreadList
      .querySelector(`[data-thread-id="${CSS.escape(nextThreadId)}"]`)
      ?.focus();
  });
}

function bootstrap() {
  setLinks();
  updateModelChoices([]);
  const initialThread = createThread();
  state.lab.currentThreadId = initialThread.id;
  loadThreadControls(initialThread);
  installEvents();
  applySnapshot(initialSnapshot);
  renderLab();
  void fetchModels();
  connectStream();
  const resumeConversationId = sessionStorage.getItem(
    "claude-proxy:resume-conversation",
  );
  if (resumeConversationId) {
    sessionStorage.removeItem("claude-proxy:resume-conversation");
    void resumeStoredConversation(resumeConversationId);
  }
}

bootstrap();
