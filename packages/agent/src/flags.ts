import type { FlowDefinition } from '@healops/shared';

/**
 * Pick which flows to replay for a flag report, based on keywords in the note and URL.
 * Returns the matched flow first; if nothing matches, every critical flow is tried in order.
 */
export function chooseFlows(note: string, url: string, flows: FlowDefinition[]): FlowDefinition[] {
  const text = `${note} ${url}`.toLowerCase();
  const byId = (id: string) => flows.find((f) => f.id === id);

  const picked: FlowDefinition[] = [];
  const add = (f: FlowDefinition | undefined) => {
    if (f && !picked.includes(f)) picked.push(f);
  };

  if (/sign[\s-]?up|register|account/.test(text)) add(byId('signup'));
  if (/cart|add[\s-]?to|basket|add\b/.test(text)) add(byId('add-to-cart'));
  if (/pay|checkout|discount|total|coupon|price/.test(text)) add(byId('checkout'));

  if (picked.length === 0) {
    for (const f of flows) if (f.critical) add(f);
  }
  return picked;
}

/** Bounded per-flow history of pass/fail results, oldest first. */
export function pushHistory(history: boolean[], ok: boolean, max = 20): boolean[] {
  const next = [...history, ok];
  return next.length > max ? next.slice(next.length - max) : next;
}
