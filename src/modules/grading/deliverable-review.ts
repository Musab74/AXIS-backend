/** Machine-readable deliverable accept/deny marker stored in EssayAnswer.expertNotes. */
const DELIVERABLE_REVIEW_RE = /^(\[DELIVERABLE:(accepted|rejected)\])\n?/;

export type DeliverableReview = 'accepted' | 'rejected';

export function parseDeliverableReview(notes: string | null | undefined): {
  review: DeliverableReview | null;
  notes: string;
} {
  if (!notes?.trim()) return { review: null, notes: '' };
  const m = notes.match(DELIVERABLE_REVIEW_RE);
  if (!m) return { review: null, notes };
  return { review: m[2] as DeliverableReview, notes: notes.slice(m[0].length) };
}

export function encodeDeliverableReview(
  review: DeliverableReview | null | undefined,
  humanNotes: string | null | undefined,
): string | null {
  const clean = (humanNotes ?? '').replace(DELIVERABLE_REVIEW_RE, '').trim();
  if (!review) return clean || null;
  if (!clean) return `[DELIVERABLE:${review}]`;
  return `[DELIVERABLE:${review}]\n${clean}`;
}

export function attachmentFileNameFromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const base = key.split('/').pop();
  return base && base.length > 0 ? base : null;
}
