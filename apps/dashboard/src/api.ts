// REST client. In demo mode every call is answered by the fixtures in demo.ts instead of the network.
import type { DashboardStats, FlowInfo, FlowRunResult, IncidentDetail, IncidentSummary, MemoryGraph } from '@healops/shared/types';
import { demoRequest } from './demo';
import { type Seed, ui } from './state';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (ui.mode === 'demo') return demoRequest<T>(method, path, body);
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok?: boolean }>('GET', '/api/health'),
  flows: () => request<FlowInfo[]>('GET', '/api/flows'),
  runFlow: (id: string) =>
    request<{ result: FlowRunResult; incidentId?: string }>('POST', `/api/flows/${encodeURIComponent(id)}/run`),
  incidents: () => request<IncidentSummary[]>('GET', '/api/incidents'),
  incident: (id: string) => request<IncidentDetail>('GET', `/api/incidents/${encodeURIComponent(id)}`),
  approve: (id: string, approved: boolean) =>
    request<unknown>('POST', `/api/incidents/${encodeURIComponent(id)}/approve`, { approved }),
  takeover: (id: string) => request<unknown>('POST', `/api/incidents/${encodeURIComponent(id)}/takeover`),
  rollback: () => request<{ restoredVersion: string }>('POST', '/api/deploy/rollback'),
  seeds: () => request<Seed[]>('GET', '/api/seeds'),
  reseed: (id: string) => request<{ version: string }>('POST', `/api/seeds/${encodeURIComponent(id)}/reseed`),
  memoryGraph: () => request<MemoryGraph>('GET', '/api/memory/graph'),
  stats: () => request<DashboardStats>('GET', '/api/stats'),
  patrol: (on: boolean) => request<unknown>('POST', on ? '/api/patrol/start' : '/api/patrol/stop'),
};
