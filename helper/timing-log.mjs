import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const fields = new Set([
  "event", "site", "instance_id", "trace_id", "request_id", "run_id", "task_id", "job_id",
  "phase", "path", "status", "started_at", "ended_at", "elapsed_ms", "model",
  "prompt_version", "reasoning_effort", "cache_hit", "title_count", "retry_count",
]);
export function safeTiming(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!fields.has(key)) continue;
    if (typeof item === "string") result[key] = item.slice(0, 160);
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
  }
  return result.event && result.phase ? result : null;
}
export function timingWriter(path) {
  return (events) => {
    const rows = events.map(safeTiming).filter(Boolean);
    if (!rows.length) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, rows.map((row) => JSON.stringify({ ...row, received_at: new Date().toISOString() })).join("\n") + "\n", { mode: 0o600 });
    } catch (error) {
      // A full disk or log permission error must not retry a contact.
      console.warn("[JSeeker][timing:write_failed]", error.code || "write_failed");
    }
  };
}
