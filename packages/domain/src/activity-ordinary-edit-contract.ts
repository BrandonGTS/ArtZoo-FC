import { invalid } from './account-contract.js';
import { ACTIVITY_LIMITS, activityId, validateCreateActivity } from './activity-contract.js';
import { ordinaryManagementTime, type OrdinaryCommand } from './activity-ordinary-management-contract.js';
export type OrdinaryEditingInput =
  | (OrdinaryCommand & {
      action: 'description';
      description: string;
      expectedPeriods: { id: string; revision: number }[];
    })
  | (OrdinaryCommand & {
      action: 'edit';
      title: string;
      description: string;
      startsAt: string;
      endsAt: string;
      location: string;
      meetingInstructions: string;
      registrationClosesAt: string;
      capacity: number | null;
    });
export function validateOrdinaryEditing(
  action: unknown,
  body: Record<string, unknown>
): OrdinaryEditingInput {
  if (action !== 'description' && action !== 'edit') invalid('action', '编辑操作无效');
  const fields =
    action === 'description'
      ? ['description', 'expectedPeriods']
      : [
          'title',
          'description',
          'startsAt',
          'endsAt',
          'location',
          'meetingInstructions',
          'registrationClosesAt',
          'capacity'
        ];
  if (Object.keys(body).some((key) => !['idempotencyKey', 'expectedRevision', ...fields].includes(key)))
    invalid('management', '包含不允许提交的字段');
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    invalid('expectedRevision', '活动版本无效，请刷新后重试');
  const command = {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    expectedRevision: Number(body.expectedRevision)
  };
  if (action === 'description') {
    const value = body.description;
    if (
      typeof value !== 'string' ||
      value.length > ACTIVITY_LIMITS.description ||
      /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value.replace(/\r?\n/g, ''))
    )
      invalid('description', '内容格式或长度无效');
    if (
      !Array.isArray(body.expectedPeriods) ||
      body.expectedPeriods.length < 2 ||
      body.expectedPeriods.length > 10
    )
      invalid('expectedPeriods', '期次版本无效，请刷新后重试');
    const expectedPeriods = body.expectedPeriods
      .map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          invalid('expectedPeriods', '期次版本无效');
        const row = value as Record<string, unknown>;
        if (
          Object.keys(row).some((key) => !['id', 'revision'].includes(key)) ||
          !Number.isSafeInteger(row.revision) ||
          Number(row.revision) < 0
        )
          invalid('expectedPeriods', '期次版本无效');
        return { id: activityId(row.id, 'expectedPeriods'), revision: Number(row.revision) };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(expectedPeriods.map((row) => row.id)).size !== expectedPeriods.length)
      invalid('expectedPeriods', '期次版本无效');
    return { ...command, action, description: value.trim(), expectedPeriods };
  }
  const parsed = validateCreateActivity({
    idempotencyKey: command.idempotencyKey,
    scene: 'OFFLINE',
    mode: 'SINGLE',
    category: 'SOCIAL',
    title: body.title,
    description: body.description,
    startsAt: ordinaryManagementTime(body.startsAt, 'startsAt'),
    endsAt: ordinaryManagementTime(body.endsAt, 'endsAt'),
    dutySelection: null,
    seats: [],
    offline: {
      location: body.location,
      meetingInstructions: body.meetingInstructions,
      registrationClosesAt: ordinaryManagementTime(body.registrationClosesAt, 'registrationClosesAt'),
      capacity: body.capacity
    }
  });
  return {
    ...command,
    action: 'edit',
    title: parsed.title,
    description: parsed.description,
    startsAt: parsed.startsAt,
    endsAt: parsed.endsAt,
    ...parsed.offline!
  };
}
