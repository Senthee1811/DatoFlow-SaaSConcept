/**
 * Round-robin assignment: the member after the one chosen last time, skipping anyone who can no
 * longer take leads. `cursor` counts the picks so far. Returns null when nobody is eligible.
 */
export function pickRoundRobin(
  userIds: readonly string[],
  cursor: number,
  eligible: (userId: string) => boolean,
): { userId: string; cursor: number } | null {
  const n = userIds.length;
  for (let step = 0; step < n; step += 1) {
    const at = (((cursor + step) % n) + n) % n;
    const userId = userIds[at]!;
    if (eligible(userId)) return { userId, cursor: cursor + step + 1 };
  }
  return null;
}

/** Placeholders an email or notification may use. Values are fixed when the action runs. */
export const TEMPLATE_VARIABLES = ['lead.name', 'lead.company', 'owner.name', 'org.name'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** Fills `{{lead.name}}` and the other placeholders. Unknown ones are left as typed. */
export function renderTemplate(
  text: string,
  values: Partial<Record<TemplateVariable, string | null>>,
): string {
  return text.replace(/\{\{\s*([a-z]+\.[a-z]+)\s*\}\}/g, (match, key: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(key)) return match;
    return values[key as TemplateVariable] ?? '';
  });
}

/** Tags are trimmed, lower-cased and unique, so "VIP" and "vip " are the same tag. */
export function normaliseTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
}

/** The lead's tags after an add or remove action. */
export function applyTags(
  current: readonly string[],
  op: 'add' | 'remove',
  tags: readonly string[],
): string[] {
  const change = normaliseTags(tags);
  if (op === 'add') return normaliseTags([...current, ...change]);
  return current.filter((t) => !change.includes(t));
}
