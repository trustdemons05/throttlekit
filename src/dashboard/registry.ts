import type { AnalyticsSnapshot } from '../analytics/types.js';
import type { DashboardMessage } from './types.js';

export class DashboardRegistry {
  private sources: Map<string, { analytics(): AnalyticsSnapshot }> = new Map();

  register(name: string, source: { analytics(): AnalyticsSnapshot }): void {
    this.sources.set(name, source);
  }

  unregister(name: string): void {
    this.sources.delete(name);
  }

  snapshot(): DashboardMessage {
    const sources: DashboardMessage['sources'] = [];
    for (const [name, source] of this.sources) {
      sources.push({ name, snapshot: source.analytics() });
    }
    return {
      type: 'snapshot',
      timestamp: Date.now(),
      sources,
    };
  }

  get size(): number {
    return this.sources.size;
  }
}
