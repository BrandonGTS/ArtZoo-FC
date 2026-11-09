import OperationMenu from '../operation-menu';

export default function DailyDeleteMenu({
  label,
  disabled = false,
  onDelete,
  onEdit,
  onModerate
}: {
  label: string;
  disabled?: boolean;
  onDelete?(): void;
  onEdit?(): void;
  onModerate?(): void;
}) {
  return (
    <OperationMenu
      label={label}
      disabled={disabled}
      items={[
        ...(onEdit ? [{ key: 'edit', label: '修改' }] : []),
        ...(onDelete ? [{ key: 'delete', label: '删除', danger: true }] : []),
        ...(onModerate ? [{ key: 'moderate', label: '违规删除', danger: true }] : [])
      ]}
      onAction={(key) => {
        if (key === 'edit') onEdit?.();
        else if (key === 'moderate') onModerate?.();
        else onDelete?.();
      }}
    />
  );
}
