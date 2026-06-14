/**
 * Lightweight passphrase strength heuristic (OQ-7 resolution).
 *
 * Story 1.9 — Architecture resolved OQ-7 to a lightweight heuristic of
 * `length × character-class diversity`. zxcvbn is explicitly deferred to
 * post-MVP. FR-41: no minimum is enforced; the meter is guidance only.
 *
 * The four character classes are: lowercase, uppercase, digit, non-alphanumeric.
 * Score = length × (1 + 0.25 × (classes - 1)). Thresholds calibrated to show
 * red below ~12 characters per the brief's `[ASSUMPTION]`.
 */

export type StrengthLevel = 'weak' | 'ok' | 'strong';

export interface StrengthAssessment {
  readonly score: number;
  readonly level: StrengthLevel;
}

const WEAK_LENGTH_FLOOR = 12;
const STRONG_SCORE_THRESHOLD = 20;

export function scorePassphrase(input: string): StrengthAssessment {
  const length = input.length;
  const classes = countCharacterClasses(input);
  const score = length * (1 + 0.25 * Math.max(0, classes - 1));

  let level: StrengthLevel;
  if (length < WEAK_LENGTH_FLOOR) {
    level = 'weak';
  } else if (score >= STRONG_SCORE_THRESHOLD) {
    level = 'strong';
  } else {
    level = 'ok';
  }

  return { score, level };
}

function countCharacterClasses(s: string): number {
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/[0-9]/.test(s)) classes++;
  if (/[^a-zA-Z0-9]/.test(s)) classes++;
  return classes;
}
