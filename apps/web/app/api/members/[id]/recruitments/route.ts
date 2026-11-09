import { failure, sessionToken, success } from '../../../../../server/auth/http';
import { getAccountService } from '../../../../../server/auth/runtime';
import { MemberRecruitmentService } from '../../../../../server/members/recruitments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const token = await sessionToken(),
      { id } = await context.params;
    return success(
      await new MemberRecruitmentService(getAccountService()).list(id, new URL(request.url), token)
    );
  } catch (error) {
    return failure(error, 'api/members/[id]/recruitments/route');
  }
}
