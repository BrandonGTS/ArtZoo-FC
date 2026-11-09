'use client';
import { useRouter } from 'next/navigation';
import { CollectionTabs } from '../collection-controls';
const groups = {
  appeals: [
    { key: '/admin/attendance-appeals', label: '到场申诉' },
    { key: '/admin/penalty-appeals', label: '处罚申诉' }
  ]
};
export function AdminSectionTabs({
  group,
  active,
  disabled = false
}: {
  group: keyof typeof groups;
  active: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  return (
    <CollectionTabs
      tabs={groups[group]}
      activeKey={active}
      disabled={disabled}
      onTabChange={(key) => router.push(key, { scroll: false })}
    />
  );
}
