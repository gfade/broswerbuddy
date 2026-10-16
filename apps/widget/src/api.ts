import type { FlagRequest, FlagResponse, IncidentLite } from './types';

const POLL_MS = 3000;
const POLL_LIMIT_MS = 10 * 60 * 1000;

/** Sends a report. Throws on network errors and non-2xx responses. */
export async function postFlag(endpoint: string, body: FlagRequest): Promise<FlagResponse> {
  const res = await fetch(`${endpoint}/api/flags`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as FlagResponse;
}

async function getIncident(endpoint: string, id: string): Promise<IncidentLite> {
  const res = await fetch(`${endpoint}/api/incidents/${encodeURIComponent(id)}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as IncidentLite;
}

/**
 * Polls an incident every 3s for up to 10 minutes. `onUpdate` returns true to stop polling.
 * Transient errors are retried on the next tick. Returns a function that cancels polling.
 */
export function pollIncident(
  endpoint: string,
  id: string,
  onUpdate: (inc: IncidentLite) => boolean,
  onTimeout: () => void,
): () => void {
  const deadline = Date.now() + POLL_LIMIT_MS;
  let timer: number | undefined;
  let stopped = false;

  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (Date.now() >= deadline) {
      stop();
      onTimeout();
      return;
    }
    try {
      const inc = await getIncident(endpoint, id);
      if (stopped) return;
      if (onUpdate(inc)) {
        stop();
        return;
      }
    } catch {
      /* transient: try again on the next tick */
    }
    if (!stopped) timer = window.setTimeout(tick, POLL_MS);
  };

  timer = window.setTimeout(tick, POLL_MS);
  return stop;
}
