/**
 * Minimal metrics registry with Prometheus text output (GET /metrics).
 *
 * WHY METRICS AND NOT JUST LOGS: logs answer "what happened to THIS request?". Metrics answer "how is
 * the SYSTEM doing?": error rate, latency and queue age over time. Dashboards and alerts are built on
 * metrics.
 *
 * Kept dependency-free for learning. A production service would use the `prom-client` package or
 * OpenTelemetry. The concepts (counter, histogram, labels) are the same.
 */

type Labels = Record<string, string>;
const key = (name: string, labels: Labels) =>
  Object.keys(labels).length === 0
    ? name // Prometheus: a metric without labels is written without braces
    : `${name}{${Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`)
        .join(',')}}`;

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<
    string,
    { buckets: number[]; counts: number[]; sum: number; count: number; name: string; labels: Labels }
  >();
  private help = new Map<string, string>();

  describe(name: string, text: string): void {
    this.help.set(name, text);
  }

  /** Counter: only goes up (e.g. requests served, payments posted). */
  inc(name: string, labels: Labels = {}, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  /** Gauge: a current value that goes up and down (e.g. outbox messages pending). */
  set(name: string, value: number, labels: Labels = {}): void {
    this.gauges.set(key(name, labels), value);
  }

  /** Histogram: distribution of values (e.g. request latency), so p95/p99 can be computed. */
  observe(
    name: string,
    value: number,
    labels: Labels = {},
    buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  ): void {
    const k = key(name, labels);
    let h = this.histograms.get(k);
    if (!h)
      this.histograms.set(k, (h = { buckets, counts: buckets.map(() => 0), sum: 0, count: 0, name, labels }));
    h.buckets.forEach((b, i) => {
      if (value <= b) h.counts[i]!++;
    });
    h.sum += value;
    h.count++;
  }

  /** Prometheus exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, text] of this.help) lines.push(`# HELP ${name} ${text}`);
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    for (const h of this.histograms.values()) {
      const lbl = (extra: Labels) => key(`${h.name}_bucket`, { ...h.labels, ...extra });
      h.buckets.forEach((b, i) => lines.push(`${lbl({ le: String(b) })} ${h.counts[i]}`));
      lines.push(`${lbl({ le: '+Inf' })} ${h.count}`);
      lines.push(`${key(`${h.name}_sum`, h.labels)} ${h.sum}`);
      lines.push(`${key(`${h.name}_count`, h.labels)} ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
