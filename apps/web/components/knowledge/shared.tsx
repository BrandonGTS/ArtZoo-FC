/* eslint-disable @next/next/no-img-element -- authenticated animated media must bypass the image optimizer */
'use client';
import { Tag } from 'antd';
import { createElement, type CSSProperties, type ReactNode } from 'react';
import {
  readKnowledgeDocument,
  knowledgeImageId,
  knowledgePreviewDimensions,
  type KnowledgeImageDimensions,
  type RichNode,
  type BodyFormat
} from '../../content/knowledge-document';
import StickerText from '../stickers/sticker-text';
import { stickerToken } from '../stickers/sticker-codec';
import './rich-editor.css';
import type { ArticleSummary } from '../../server/knowledge/contract';
export const date = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
export function ArticleTags({ article }: { article: ArticleSummary }) {
  return (
    <div className="knowledge-tags">
      <Tag variant="outlined">{article.category.label}</Tag>
      {[...article.jobs, ...article.playstyles, ...article.gameVersions].map((tag, i) => (
        <Tag variant="outlined" key={i}>
          {tag}
        </Tag>
      ))}
    </div>
  );
}
export function Failure({ message }: { message: string | null }) {
  return message ? (
    <p className="knowledge-error" role="alert">
      {message}
    </p>
  ) : null;
}

function presentation(node: RichNode): CSSProperties {
  const a = node.attrs ?? {};
  return {
    textAlign: a.textAlign as CSSProperties['textAlign'],
    lineHeight: a.lineHeight as number | undefined,
    marginLeft: a.indent ? Number(a.indent) * 2 + 'em' : undefined
  };
}
function renderNode(
  node: RichNode,
  index: number,
  imageDimensions: Record<string, KnowledgeImageDimensions> = {}
): ReactNode {
  if (node.type === 'text') {
    let result: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      const a = mark.attrs ?? {};
      if (mark.type === 'bold') result = <strong key={mark.type}>{result}</strong>;
      else if (mark.type === 'italic') result = <em key={mark.type}>{result}</em>;
      else if (mark.type === 'underline') result = <u key={mark.type}>{result}</u>;
      else if (mark.type === 'strike') result = <s key={mark.type}>{result}</s>;
      else if (mark.type === 'textStyle')
        result = (
          <span
            key={mark.type}
            style={{
              fontSize: a.fontSize as string,
              color: a.color as string,
              backgroundColor: a.backgroundColor as string
            }}
          >
            {result}
          </span>
        );
      else if (mark.type === 'link')
        result = (
          <a
            key={mark.type}
            href={String(a.href)}
            title={a.title ? String(a.title) : undefined}
            target={String(a.target ?? '_blank')}
            rel="noopener noreferrer"
          >
            {result}
          </a>
        );
    }
    return <span key={index}>{result}</span>;
  }
  const children = node.content?.map((child, i) => renderNode(child, i, imageDimensions)),
    a = node.attrs ?? {};
  if (node.type === 'sticker') return <StickerText key={index} text={stickerToken(String(a.id)) ?? ''} />;
  if (node.type === 'image') {
    const dimensions = knowledgePreviewDimensions(imageDimensions[knowledgeImageId(a.src)] ?? a);
    return (
      <figure key={index}>
        <img
          src={String(a.src)}
          alt={String(a.alt ?? '')}
          width={dimensions?.width}
          height={dimensions?.height}
          loading="lazy"
        />
        {a.title ? <figcaption>{String(a.title)}</figcaption> : null}
      </figure>
    );
  }
  if (node.type === 'hardBreak') return <br key={index} />;
  if (node.type === 'table')
    return (
      <div key={index} className="knowledge-table-scroll">
        <table style={{ width: Number(a.width ?? 100) + '%' }}>
          <tbody>{children}</tbody>
        </table>
      </div>
    );
  if (node.type === 'tableRow')
    return (
      <tr key={index} style={{ height: a.height ? Number(a.height) : undefined }}>
        {children}
      </tr>
    );
  if (node.type === 'tableCell' || node.type === 'tableHeader')
    return createElement(
      node.type === 'tableCell' ? 'td' : 'th',
      {
        key: index,
        colSpan: Number(a.colspan ?? 1),
        rowSpan: Number(a.rowspan ?? 1),
        style: {
          ...presentation(node),
          backgroundColor: a.backgroundColor,
          width: Array.isArray(a.colwidth) ? Number(a.colwidth[0]) : undefined
        }
      },
      children
    );
  if (node.type === 'details') return <details key={index}>{children}</details>;
  if (node.type === 'detailsSummary') return <summary key={index}>{children}</summary>;
  if (node.type === 'detailsContent') return <div key={index}>{children}</div>;
  const tags: Record<string, string> = {
    paragraph: 'p',
    heading: 'h' + Number(a.level ?? 2),
    bulletList: 'ul',
    orderedList: 'ol',
    listItem: 'li',
    blockquote: 'blockquote'
  };
  if (node.type === 'codeBlock')
    return (
      <pre key={index}>
        <code>{children}</code>
      </pre>
    );
  if (node.type === 'orderedList')
    return (
      <ol key={index} start={Number(a.start ?? 1)}>
        {children}
      </ol>
    );
  return createElement(tags[node.type] ?? 'div', { key: index, style: presentation(node) }, children);
}
export function ArticleBody({
  body,
  bodyFormat = 'PLAIN',
  imageDimensions = {}
}: {
  body: string;
  bodyFormat?: BodyFormat;
  imageDimensions?: Record<string, KnowledgeImageDimensions>;
}) {
  if (bodyFormat === 'PLAIN') return <div className="knowledge-body">{body}</div>;
  return (
    <div className="knowledge-body knowledge-rich-body knowledge-rich-typography">
      {readKnowledgeDocument(body, bodyFormat).content.map((node, index) =>
        renderNode(node, index, imageDimensions)
      )}
    </div>
  );
}
