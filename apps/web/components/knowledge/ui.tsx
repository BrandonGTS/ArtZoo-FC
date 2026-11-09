import { Tag } from 'antd';
export function KnowledgeCategoryTag({ label }: { label: string }) {
  return (
    <Tag variant="solid" className="knowledge-category-tag">
      {label}
    </Tag>
  );
}
export function KnowledgeTimeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
export function KnowledgeActionIcon({ kind }: { kind: 'read' | 'collect' | 'share' }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'read' ? (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : kind === 'collect' ? (
        <path d="M6 3h12v18l-6-4-6 4V3Z" />
      ) : (
        <>
          <path d="M12 16V3m-5 5 5-5 5 5M5 13v8h14v-8" />
        </>
      )}
    </svg>
  );
}
