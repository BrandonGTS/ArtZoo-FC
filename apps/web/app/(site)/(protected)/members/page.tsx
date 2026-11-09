import MemberDirectory from '../../../../components/members/member-directory';
import { requirePageAccount } from '../../../../server/auth/page-guards';

export default async function MembersPage({
  searchParams
}: {
  searchParams: Promise<{ query?: string | string[]; membership?: string | string[] }>;
}) {
  await requirePageAccount('/members');
  const values = await searchParams;
  const query = typeof values.query === 'string' ? values.query : '';
  const membership =
    values.membership === 'MEMBER' || values.membership === 'FRIEND' ? values.membership : '';
  return <MemberDirectory key={query} initialQuery={query} membership={membership} />;
}
