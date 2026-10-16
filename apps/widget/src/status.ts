import type { IncidentLite } from './types';

/** Pipeline stage (from stage.changed events) to the progress line shown while it runs. */
const STAGE_LABEL: Record<string, string> = {
  detect: 'Looking into it…',
  triage: 'Triaging the report…',
  recall: 'Checking for similar bugs…',
  reproduce: 'Reproducing…',
  patch: 'Writing a fix…',
  verify: 'Verifying the fix…',
  gate: 'Running safety checks…',
  deploy: 'Deploying…',
  judge: 'Reviewing the fix…',
  learn: 'Wrapping up…',
};

/** Incident status to progress line, used when no stage is running. */
const STATUS_LABEL: Record<string, string> = {
  open: 'Looking into it…',
  healing: 'Working on it…',
  awaiting_approval: 'Waiting for approval…',
};

/** Terminal statuses other than `healed`, with the line shown to the reporter. */
const FINAL_DETAIL: Record<string, string> = {
  quarantined: 'Our team will review this report.',
  rejected: 'Our team will review this report.',
  escalated: 'We passed this to our team for a closer look.',
  not_reproducible: "We couldn't reproduce it yet, but we're still looking.",
  rolled_back: 'We tried a fix and rolled it back. Our team will take a look.',
  failed: 'Something went wrong on our side. Our team will take a look.',
};

const has = (map: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

export const isTerminal = (status: string): boolean => status === 'healed' || has(FINAL_DETAIL, status);

export function finalDetail(status: string): string {
  return has(FINAL_DETAIL, status) ? FINAL_DETAIL[status] : 'Our team will take a look.';
}

/** Progress line from the last stage.changed event (if a stage is running), else from the status. */
export function progressText(inc: IncidentLite): string {
  let stage: { stage?: string; status?: string } | undefined;
  for (const e of inc.events ?? []) {
    if (e.type === 'stage.changed') stage = e;
  }
  if (stage?.status === 'started' && stage.stage && has(STAGE_LABEL, stage.stage)) {
    return STAGE_LABEL[stage.stage];
  }
  return has(STATUS_LABEL, inc.status) ? STATUS_LABEL[inc.status] : 'Working on it…';
}

/** Version from the latest store.version or promoted deploy.progress event, if any. */
export function versionOf(inc: IncidentLite): string | undefined {
  let version: string | undefined;
  for (const e of inc.events ?? []) {
    const promoted = e.type === 'deploy.progress' && e.phase === 'promoted';
    if ((e.type === 'store.version' || promoted) && e.version) version = e.version;
  }
  return version;
}
