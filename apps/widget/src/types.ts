/**
 * Wire types for the widget. Deliberately NOT imported from @healops/shared (Node-only):
 * these mirror just the fields the widget sends or reads.
 */

/** A user interaction. `target` is a short descriptor; input values and text are never recorded. */
export interface CapturedEvent {
  type: 'click' | 'input' | 'submit' | 'change';
  target: string;
  at: number;
}

/** POST {endpoint}/api/flags */
export interface FlagRequest {
  note: string;
  url: string;
  events: CapturedEvent[];
  consoleErrors: string[];
  viewport: [number, number];
  userAgent: string;
}

export interface FlagResponse {
  flagId: string;
  quarantined: boolean;
  incidentId?: string;
  reason?: string;
}

/** GET {endpoint}/api/incidents/:id (only the fields the widget reads). */
export interface IncidentLite {
  id: string;
  status: string;
  events?: {
    type: string;
    stage?: string;
    status?: string;
    version?: string;
    phase?: string;
  }[];
}
