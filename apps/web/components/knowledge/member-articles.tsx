'use client';
import Link from 'next/link';
import { useAuthSession } from '../auth-session';
import { useResource } from '../account/use-resource';
import { MemberPaper } from '../members/member-ui';
import { PageHeading } from '../home-content';
import type { ArticleSummary } from '../../server/knowledge/contract';
import { date } from './shared';
import './knowledge.css';
export default function MemberArticles({ authorId }: { authorId: string }) {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor ? (
    <OwnedArticles
      key={[actor.id, actor.membership, actor.adminRole, authorId].join(':')}
      authorId={authorId}
    />
  ) : null;
}
function OwnedArticles({ authorId }: { authorId: string }) {
  const resource = useResource<{ items: ArticleSummary[] }>(
    '/api/knowledge?author=' + encodeURIComponent(authorId)
  );
  return (
    <section className="home-section member-articles">
      <PageHeading decoration="patty">分享的文章</PageHeading>
      <MemberPaper>
        {resource.error ? (
          <p role="alert">{resource.error}</p>
        ) : resource.loading ? (
          <p role="status">正在读取文章…</p>
        ) : !resource.data?.items.length ? (
          <p>暂无分享的文章</p>
        ) : (
          resource.data.items.slice(0, 2).map((article) => (
            <article className="knowledge-member-article" key={article.id}>
              <h3>
                <Link href={'/knowledge/' + article.id}>{article.title}</Link>
              </h3>
              <p className="auxiliary">{date(article.createdAt)}</p>
              <p>{article.summary}</p>
            </article>
          ))
        )}
      </MemberPaper>
    </section>
  );
}
