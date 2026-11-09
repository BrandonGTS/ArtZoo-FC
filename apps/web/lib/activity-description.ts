// Keep the publisher's existing plain-text format; do not infer headings from prose.
const label = '参与要求：\n';
const separator = '\n\n' + label;
export function splitActivityDescription(value: string) {
  if (value.startsWith(label)) return { arrangement: '', requirements: value.slice(label.length) };
  const index = value.indexOf(separator);
  return index < 0
    ? { arrangement: value, requirements: null }
    : { arrangement: value.slice(0, index), requirements: value.slice(index + separator.length) };
}
export function composeActivityDescription(arrangement = '', requirements = '', original?: string) {
  if (original !== undefined) {
    const saved = splitActivityDescription(original);
    // Editing other fields must not normalize or rewrite an existing description.
    if (arrangement === saved.arrangement && requirements === (saved.requirements ?? '')) return original;
  }
  return [arrangement.trim(), requirements.trim() ? label + requirements.trim() : '']
    .filter(Boolean)
    .join('\n\n');
}

// New publishing requires both sections. Existing edit commands retain historical compatibility.
export function missingActivityDescriptionFields(value: string) {
  const parts = splitActivityDescription(value);
  return {
    arrangement: !parts.arrangement.trim(),
    requirements: !parts.requirements?.trim()
  };
}
