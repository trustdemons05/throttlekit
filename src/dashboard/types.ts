import type { AnalyticsSnapshot } from '../analytics/types.js';

export interface DashboardOptions {
  port?: number;
  host?: string;
  refreshMs?: number;
}

export interface DashboardSource {
  name: string;
  analytics(): AnalyticsSnapshot;
}

export interface DashboardMessage {
  type: 'snapshot';
  timestamp: number;
  sources: Array<{
    name: string;
    snapshot: AnalyticsSnapshot;
  }>;
}
