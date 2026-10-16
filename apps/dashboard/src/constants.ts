import type { IncidentStatus, Severity, Sponsor, Stage } from '@healops/shared/types';

// Local copies of the shared runtime constants (the dashboard only imports shared *types*).
export const STAGES: Stage[] = [
  'detect', 'triage', 'recall', 'reproduce', 'patch', 'verify', 'gate', 'deploy', 'judge', 'learn',
];

export const STAGE_SPONSOR: Record<Stage, Sponsor> = {
  detect: 'anchor',
  triage: 'bedrock',
  recall: 'surreal',
  reproduce: 'daytona',
  patch: 'bedrock',
  verify: 'daytona',
  gate: 'arize',
  deploy: 'aws',
  judge: 'arize',
  learn: 'surreal',
};

export const STAGE_LABEL: Record<Stage, string> = {
  detect: 'Detect',
  triage: 'Triage',
  recall: 'Recall',
  reproduce: 'Reproduce',
  patch: 'Patch',
  verify: 'Verify',
  gate: 'Gate',
  deploy: 'Deploy',
  judge: 'Judge',
  learn: 'Learn',
};

export const STAGE_TITLE: Record<Stage, string> = {
  detect: 'Detect · flow run',
  triage: 'Triage · guard and severity',
  recall: 'Recall · memory',
  reproduce: 'Reproduce · sandbox',
  patch: 'Fix · reasoning and patch',
  verify: 'Verify · re-run',
  gate: 'Gate · risk and approval',
  deploy: 'Deploy · canary',
  judge: 'Judge · eval and trace',
  learn: 'Learn · memory write',
};

/** Sponsor identity: colour follows the sponsor, never its rank. Bedrock and AWS share the AWS family. */
export const SPONSOR_INFO: Record<Sponsor, { label: string; css: string }> = {
  anchor: { label: 'Anchor', css: 'var(--anchor)' },
  surreal: { label: 'SurrealDB', css: 'var(--surreal)' },
  daytona: { label: 'Daytona', css: 'var(--daytona)' },
  bedrock: { label: 'Bedrock', css: 'var(--aws)' },
  aws: { label: 'AWS', css: 'var(--aws)' },
  arize: { label: 'Arize', css: 'var(--arize)' },
};

export const SEVERITY_INFO: Record<Severity, { label: string; css: string }> = {
  sev1: { label: 'SEV-1', css: 'var(--bad)' },
  sev2: { label: 'SEV-2', css: 'var(--warn)' },
  sev3: { label: 'SEV-3', css: 'var(--info)' },
};

/** Status always ships with an icon and a label, never colour alone. */
export const STATUS_INFO: Record<IncidentStatus, { label: string; icon: string; css: string }> = {
  open: { label: 'OPEN', icon: '●', css: 'var(--info)' },
  healing: { label: 'HEALING', icon: '◐', css: 'var(--warn)' },
  awaiting_approval: { label: 'NEEDS APPROVAL', icon: '!', css: 'var(--warn)' },
  healed: { label: 'HEALED', icon: '✓', css: 'var(--ok)' },
  rolled_back: { label: 'ROLLED BACK', icon: '↶', css: 'var(--warn)' },
  escalated: { label: 'ESCALATED', icon: '↑', css: 'var(--info)' },
  quarantined: { label: 'QUARANTINED', icon: '■', css: 'var(--bad)' },
  not_reproducible: { label: 'NOT REPRODUCIBLE', icon: '?', css: 'var(--muted)' },
  rejected: { label: 'REJECTED', icon: '✕', css: 'var(--bad)' },
  failed: { label: 'FAILED', icon: '✕', css: 'var(--bad)' },
};

export const SOURCE_LABEL: Record<string, string> = {
  patrol: 'Anchor patrol',
  flag: 'User flag',
  manual: 'Manual',
};
