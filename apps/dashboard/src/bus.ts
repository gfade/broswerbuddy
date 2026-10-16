// Single entry point for applying events from any source (live WebSocket or the scripted demo).
import type { IncidentEvent } from '@healops/shared/types';
import { applyEvent } from './model';
import { emit } from './state';

type Hook = (e: IncidentEvent) => void;
const hooks = new Set<Hook>();

/** Register a side effect that runs after every published event (e.g. REST refreshes). */
export function onEvent(fn: Hook): () => void {
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
}

export function publish(e: IncidentEvent): void {
  applyEvent(e);
  for (const fn of hooks) {
    try {
      fn(e);
    } catch (err) {
      console.error('[healops-ui] event hook failed', err);
    }
  }
  emit();
}
