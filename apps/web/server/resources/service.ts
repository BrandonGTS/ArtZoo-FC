import { AccountError } from '@artzoo/domain';
import { AccountService } from '../auth/service';
import { resourceId, invalidResource, type ResourceCategory, type ResourceView } from './contract';
export class ResourceService {
  constructor(readonly auth: AccountService) {}
  async categories() {
    return {
      items: await this.auth.db.$queryRaw<
        ResourceCategory[]
      >`SELECT "id", "name", "revision" FROM "ResourceCategory" ORDER BY "name", "id"`
    };
  }
  async list(url: URL) {
    const categoryId = url.searchParams.get('categoryId')
      ? resourceId(url.searchParams.get('categoryId'))
      : null;
    const query = url.searchParams.get('query')?.trim() ?? '';
    if (query.length > 100) invalidResource('搜索内容过长');
    // Parameters are literal substrings, including %, _ and SQL punctuation.
    const items = await this.auth.db.$queryRaw<
      ResourceView[]
    >`SELECT r."id", r."name", r."purpose", r."url", r."categoryId", r."revision", c."name" AS "categoryName" FROM "ResourceLink" r JOIN "ResourceCategory" c ON c."id" = r."categoryId" WHERE (${categoryId}::text IS NULL OR r."categoryId" = ${categoryId}) AND (${query} = '' OR strpos(lower(r."name"), lower(${query})) > 0 OR strpos(lower(r."purpose"), lower(${query})) > 0) ORDER BY r."name", r."id"`;
    return { items };
  }
  async save(body: Record<string, unknown>, token?: string | null, id?: string, category = false) {
    void body;
    void id;
    void category;
    await this.auth.requireAccount(this.auth.db, token, true);
    throw new AccountError('FORBIDDEN', '固定配置由开发维护', 403);
  }
}
