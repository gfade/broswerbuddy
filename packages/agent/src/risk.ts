import type { Autonomy } from '@healops/shared';

export const SENSITIVE_PATH = /pay|checkout|auth|secret|config/i;

export interface RiskInput {
  changedFiles: string[];
  /** total changed lines (added + removed) across all edits */
  changedLines: number;
  /** patch confidence 0..1 */
  confidence: number;
  /** judge score 0..100 computed before deploy */
  preScore: number;
}

export interface RiskResult {
  risk: number;
  reasons: string[];
}

/**
 * Risk 0..100: +25 for sensitive paths, up to +25 for change size,
 * (1 - confidence) * 30, and (100 - preScore) * 0.3.
 */
export function assessRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];
  let risk = 0;

  const sensitive = input.changedFiles.filter((p) => SENSITIVE_PATH.test(p));
  if (sensitive.length > 0) {
    risk += 25;
    reasons.push(`touches sensitive path: ${sensitive.join(', ')} (+25)`);
  }

  const sizePts = Math.min(25, Math.max(0, input.changedLines));
  if (sizePts > 0) {
    risk += sizePts;
    reasons.push(`${input.changedLines} changed line(s) (+${sizePts})`);
  }

  const conf = Math.min(1, Math.max(0, input.confidence));
  const confPts = (1 - conf) * 30;
  if (confPts > 0.05) {
    risk += confPts;
    reasons.push(`confidence ${Math.round(conf * 100)}% (+${confPts.toFixed(1)})`);
  }

  const score = Math.min(100, Math.max(0, input.preScore));
  const judgePts = (100 - score) * 0.3;
  if (judgePts > 0.05) {
    risk += judgePts;
    reasons.push(`pre-deploy judge score ${Math.round(score)} (+${judgePts.toFixed(1)})`);
  }

  risk = Math.round(Math.min(100, Math.max(0, risk)));
  if (reasons.length === 0) reasons.push('small, confident, judged-good change');
  return { risk, reasons };
}

export type GateDecision = 'auto' | 'needs_approval' | 'blocked';

/** Map autonomy level + risk to a gate decision. */
export function decide(autonomy: Autonomy, risk: number, riskThreshold: number): GateDecision {
  switch (autonomy) {
    case 'observe':
      return 'blocked';
    case 'suggest':
      return 'needs_approval';
    case 'auto_low':
      return risk < riskThreshold ? 'auto' : 'needs_approval';
    case 'full':
      return 'auto';
  }
}

/** Count changed lines (added + removed) in a unified diff. */
export function countChangedLines(diff: string): number {
  let n = 0;
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) n++;
  }
  return n;
}
