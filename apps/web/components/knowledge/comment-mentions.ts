export type MentionBinding = { id: string; label: string };

export function appendKnowledgeMention(body: string, label: string) {
  return `${body}${body && !/\s$/.test(body) ? ' ' : ''}@${label} `;
}

export function activeKnowledgeMentions(body: string, selected: MentionBinding[]) {
  return [
    ...new Set(
      selected
        .filter(({ label }) => {
          const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp('(?:^|\\s)@' + escaped + '(?=\\s|$)').test(body);
        })
        .map(({ id }) => id)
    )
  ].sort();
}
