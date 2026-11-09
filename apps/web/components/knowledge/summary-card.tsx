/* eslint-disable @next/next/no-img-element -- authenticated knowledge media uses its existing private route */
'use client';
import Link from 'next/link';
import { MemberPaper, MemberAvatar } from '../members/member-ui';
import HomeCardSurface from '../home-card-surface';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import type { ArticleSummary } from '../../server/knowledge/contract';
import { date } from './shared';
import { KnowledgeCategoryTag, KnowledgeTimeIcon } from './ui';
export function KnowledgeSummaryCard({ article }: { article: ArticleSummary }) {
  const thumbnails = (article.thumbnailUrls ?? []).slice(0, 3),
    location = [article.author.gameRegion, article.author.gameServer].filter(Boolean).join(' · ');
  return (
    <HomeCardSurface motionProfile="feed" navigation="card">
      <MemberPaper className="knowledge-summary-paper">
        <article className="knowledge-summary">
          <div className="knowledge-summary-main">
            <div className="knowledge-title-row">
              <KnowledgeCategoryTag label={article.category.label} />
              <h2 className="knowledge-summary-title">
                <Link data-home-card-link href={'/knowledge/' + article.id}>
                  {article.title}
                </Link>
              </h2>
            </div>
            {thumbnails.length ? (
              <Link
                className="knowledge-summary-thumbnails"
                href={'/knowledge/' + article.id}
                aria-label={'查看' + article.title + '的图片'}
              >
                {thumbnails.map((src) => (
                  <img src={src} key={src} alt="" loading="lazy" />
                ))}
              </Link>
            ) : null}
          </div>
          <div className="knowledge-summary-author">
            <div className="knowledge-person">
              <Link href={'/members/' + article.author.id} data-home-card-independent>
                <MemberAvatar member={article.author} size={44} />
              </Link>
              <div className="knowledge-person-copy">
                <Link href={'/members/' + article.author.id}>{article.author.displayName || '成员'}</Link>
                {location ? (
                  <span className="daily-meta daily-home-location">
                    <DailyToolbarIcon kind="server" />
                    {location}
                  </span>
                ) : null}
                <time dateTime={article.createdAt}>
                  <KnowledgeTimeIcon />
                  {date(article.createdAt)}
                </time>
              </div>
            </div>
          </div>
        </article>
      </MemberPaper>
    </HomeCardSurface>
  );
}
