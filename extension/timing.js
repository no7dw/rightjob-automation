// Sequential, non-overlapping phases. Logging never changes pipeline control.
export class PhaseTimer {
  constructor(context, emit, now = () => performance.now(), wall = () => new Date().toISOString()) {
    this.context = context;
    this.emit = emit;
    this.now = now;
    this.wall = wall;
    this.started = this.at = now();
    this.startedAt = this.phaseAt = wall();
    this.current = null;
    this.closed = false;
  }
  send(event, data) {
    try { this.emit(event, data); } catch { /* Measurement is non-fatal. */ }
  }
  phase(name) {
    if (this.closed) return;
    const at = this.now();
    const timestamp = this.wall();
    if (this.current) this.send("timing:phase", {
      ...this.context, phase: this.current, started_at: this.phaseAt,
      ended_at: timestamp, elapsed_ms: Math.round((at - this.at) * 100) / 100,
    });
    this.current = name;
    this.at = at;
    this.phaseAt = timestamp;
  }
  finish(status) {
    if (this.closed) return;
    this.phase(null);
    this.closed = true;
    this.send("timing:total", {
      ...this.context, phase: "total", status, started_at: this.startedAt,
      ended_at: this.wall(), elapsed_ms: Math.round((this.now() - this.started) * 100) / 100,
    });
  }
}
