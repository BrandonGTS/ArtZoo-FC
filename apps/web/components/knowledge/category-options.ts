import type { Category } from '../../server/knowledge/contract';

export const KNOWLEDGE_SECTIONS = [
  '日常杂谈',
  '同人创作',
  '剧情讨论',
  '游戏记录',
  '举手提问',
  '建议和BUG反馈'
] as const;

/** Keep every legacy category in browse filters, after the six current sections. */
export function browseCategoryOptions(categories: Category[]) {
  return [
    ...KNOWLEDGE_SECTIONS.flatMap((label) => categories.filter((category) => category.label === label)),
    ...categories.filter((category) => !KNOWLEDGE_SECTIONS.some((label) => label === category.label))
  ].map((category) => ({ value: category.id, label: category.label }));
}

/** Existing articles retain their original category, including a disabled one. */
export function publishCategoryOptions(categories: Category[], current?: Category) {
  const sections = KNOWLEDGE_SECTIONS.flatMap((label) =>
    categories.filter((category) => category.active && category.label === label)
  );
  const choices =
    current && !sections.some((category) => category.id === current.id) ? [...sections, current] : sections;
  return choices.map((category) => ({
    value: category.id,
    label: category.label,
    disabled: !category.active && category.id !== current?.id
  }));
}
