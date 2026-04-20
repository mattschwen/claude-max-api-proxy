import { resolveModelFamily } from "../models.js";
import type { OpsDashboardSnapshot } from "./ops-snapshot.js";

type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue>;

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

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries
    .map(
      ([name, value]) =>
        `${name}="${escapeLabelValue(normalizeLabelValue(value))}"`,
    )
    .join(",")}}`;
}

function emitGaugeHeader(
  lines: string[],
  emitted: Set<string>,
  name: string,
  help: string,
): void {
  if (emitted.has(name)) return;
  emitted.add(name);
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
}

function pushGauge(
  lines: string[],
  emitted: Set<string>,
  name: string,
  help: string,
  value: number,
  labels: Labels = {},
): void {
  emitGaugeHeader(lines, emitted, name, help);
  lines.push(`${name}${renderLabels(labels)} ${value}`);
}

function safeModelFamily(model: string | null | undefined): string {
  if (!model) return "unknown";
  return resolveModelFamily(model) ?? "unknown";
}

function shortConversationId(value: string): string {
  return value.slice(0, 12);
}

function buildOperationalPrometheusLines(
  snapshot: OpsDashboardSnapshot,
): string[] {
  const lines: string[] = [];
  const emitted = new Set<string>();

  pushGauge(
    lines,
    emitted,
    "claude_proxy_runtime_utilization_ratio",
    "Current active-request utilization against the configured global concurrency cap.",
    snapshot.queue.utilizationRatio,
  );

  for (const request of snapshot.queue.activeRequests) {
    const labels = {
      conversation_id: request.conversationId,
      conversation_short: shortConversationId(request.conversationId),
      request_id: request.requestId,
      stream: request.stream,
    };
    pushGauge(
      lines,
      emitted,
      "claude_proxy_active_request_duration_ms",
      "Duration of each currently active proxy request in milliseconds.",
      request.durationMs,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_active_request_started_timestamp_seconds",
      "Unix timestamp when each currently active proxy request began.",
      request.startedAt / 1000,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_active_request_has_cancel_handler",
      "Whether the active request currently has a cancellation handler attached.",
      request.hasCancelHandler ? 1 : 0,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_active_request_pending_cancel",
      "Whether the active request has a pending cancellation signal waiting to be delivered.",
      request.pendingCancel ? 1 : 0,
      labels,
    );
  }

  for (const queueConversation of snapshot.queue.conversations) {
    const labels = {
      conversation_id: queueConversation.conversationId,
      conversation_short: shortConversationId(queueConversation.conversationId),
      processing: queueConversation.processing,
    };
    pushGauge(
      lines,
      emitted,
      "claude_proxy_queue_conversation_depth",
      "Queued request depth for each conversation.",
      queueConversation.queued,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_queue_conversation_active",
      "Whether a conversation currently has an active request.",
      queueConversation.active ? 1 : 0,
      labels,
    );
    if (queueConversation.waitMs !== null) {
      pushGauge(
        lines,
        emitted,
        "claude_proxy_queue_conversation_wait_ms",
        "Current oldest wait time for each queued conversation in milliseconds.",
        queueConversation.waitMs,
        labels,
      );
    }
    if (queueConversation.activeDurationMs !== null) {
      pushGauge(
        lines,
        emitted,
        "claude_proxy_queue_conversation_active_duration_ms",
        "Duration of the currently active request for each conversation in milliseconds.",
        queueConversation.activeDurationMs,
        labels,
      );
    }
  }

  for (const session of snapshot.sessions) {
    const labels = {
      conversation_id: session.conversationId,
      conversation_short: shortConversationId(session.conversationId),
      session_id_short: session.sessionIdShort,
      model: session.model,
      model_family: safeModelFamily(session.model),
    };
    pushGauge(
      lines,
      emitted,
      "claude_proxy_session_age_ms",
      "Age of each active Claude session mapping in milliseconds.",
      session.ageMs,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_session_idle_ms",
      "Idle time of each active Claude session mapping in milliseconds.",
      session.idleMs,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_session_context_tokens",
      "Estimated context size for each active session in tokens.",
      session.contextTokens,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_session_resume_failures_by_session",
      "Consecutive resume failures recorded against each active session.",
      session.resumeFailures,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_session_task_count",
      "Approximate task count recorded for each active session.",
      session.taskCount,
      labels,
    );
  }

  for (const subprocess of snapshot.subprocesses) {
    const labels = {
      pid: subprocess.pid,
      model: subprocess.model,
      model_family: subprocess.modelFamily,
      reasoning_mode: subprocess.reasoningMode,
      thinking: subprocess.thinking,
      resume: subprocess.isResume,
      session_id_short: subprocess.sessionIdShort ?? "",
    };
    pushGauge(
      lines,
      emitted,
      "claude_proxy_subprocess_uptime_ms",
      "Current uptime of each active Claude subprocess in milliseconds.",
      subprocess.uptimeMs,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_subprocess_started_timestamp_seconds",
      "Unix timestamp when each active Claude subprocess started.",
      subprocess.startedAt / 1000,
      labels,
    );
  }

  for (const conversation of snapshot.recentConversations) {
    const labels = {
      conversation_id: conversation.conversationId,
      conversation_short: shortConversationId(conversation.conversationId),
      model: conversation.model ?? "unknown",
      model_family: safeModelFamily(conversation.model),
      status: conversation.status,
    };
    pushGauge(
      lines,
      emitted,
      "claude_proxy_recent_conversation_message_count",
      "Stored message count for each recent conversation.",
      conversation.messageCount,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_recent_conversation_idle_ms",
      "Idle time for each recent conversation in milliseconds.",
      conversation.idleMs,
      labels,
    );
    pushGauge(
      lines,
      emitted,
      "claude_proxy_recent_conversation_age_ms",
      "Age of each recent conversation in milliseconds.",
      conversation.ageMs,
      labels,
    );
    if (conversation.lastMessageAtMs !== null) {
      pushGauge(
        lines,
        emitted,
        "claude_proxy_recent_conversation_last_activity_timestamp_seconds",
        "Unix timestamp of the last stored message for each recent conversation.",
        conversation.lastMessageAtMs / 1000,
        labels,
      );
    }
  }

  if (snapshot.availability.checkedAtMs !== null) {
    pushGauge(
      lines,
      emitted,
      "claude_proxy_provider_models_checked_timestamp_seconds",
      "Unix timestamp when provider model availability was last checked.",
      snapshot.availability.checkedAtMs / 1000,
    );
  }

  for (const model of snapshot.availability.available) {
    pushGauge(
      lines,
      emitted,
      "claude_proxy_provider_model_up",
      "Whether each probed provider model is currently available.",
      1,
      {
        model_id: model.id,
        family: model.family,
        status: "available",
      },
    );
  }

  for (const model of snapshot.availability.unavailable) {
    pushGauge(
      lines,
      emitted,
      "claude_proxy_provider_model_up",
      "Whether each probed provider model is currently available.",
      0,
      {
        model_id: model.id,
        family: model.family,
        status: "unavailable",
      },
    );
  }

  return lines;
}

export function renderOperationalPrometheus(
  snapshot: OpsDashboardSnapshot,
): string {
  const lines = buildOperationalPrometheusLines(snapshot);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function buildOperationalJsonSnapshot(
  snapshot: OpsDashboardSnapshot,
): Record<string, unknown> {
  return {
    generatedAt: snapshot.generatedAt,
    status: snapshot.status,
    unhealthyReason: snapshot.unhealthyReason ?? null,
    config: snapshot.config,
    queue: snapshot.queue,
    sessions: snapshot.sessions,
    subprocesses: snapshot.subprocesses,
    recentConversations: snapshot.recentConversations,
    availability: snapshot.availability,
    failureStats: snapshot.failureStats,
    stallDetections: snapshot.stallDetections,
    responseConversationEntries: snapshot.responseConversationEntries,
  };
}
