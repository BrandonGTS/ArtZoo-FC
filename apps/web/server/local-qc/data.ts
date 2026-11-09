// CLI-only append importer. No route, auth bypass, account creation or session creation.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { BEIJING_OFFSET_MS } from '@artzoo/domain';
import type { Prisma, PrismaClient } from '@artzoo/db';
import { processPhoto, type PhotoOutput } from '../media/photo-processor';
import { LOCAL_QC_NAMESPACE as namespace, assertQcTransaction, type QcBindings } from './core';
import {
  LOCAL_QC_LABEL as label,
  LOCAL_QC_SLOTS,
  LOCAL_QC_DATA_MANIFEST,
  LocalQcDataError,
  localQcCanonical,
  localQcDigest,
  localQcId as id,
  validateLocalQcBindings,
  type LocalQcBindings,
  type LocalQcDataOptions,
  type LocalQcDataResult,
  type LocalQcFileReceipt
} from './data-contract';

type Tx = Prisma.TransactionClient;
type Kind =
  | 'activity'
  | 'activitySeries'
  | 'fixedTeam'
  | 'album'
  | 'knowledgeCategory'
  | 'knowledgeArticle'
  | 'dailyPost'
  | 'wish'
  | 'lottery'
  | 'resourceCategory'
  | 'resourceLink'
  | 'activityShare'
  | 'media';
interface Root {
  slot: string;
  kind: Kind;
  entityId: string;
}
const root = (slot: string, kind: Kind): Root => ({ slot, kind, entityId: id(slot) });
const roots: readonly Root[] = [
  root('ordinary-active', 'activity'),
  root('ordinary-history', 'activity'),
  root('series-period-1', 'activity'),
  root('series-period-2', 'activity'),
  root('offline-active', 'activity'),
  root('series', 'activitySeries'),
  root('team-current', 'fixedTeam'),
  root('team-history', 'fixedTeam'),
  root('album', 'album'),
  root('knowledge-category', 'knowledgeCategory'),
  root('knowledge', 'knowledgeArticle'),
  root('daily', 'dailyPost'),
  root('wish-discussion', 'wish'),
  root('wish-linked', 'wish'),
  ...Array.from({ length: 13 }, (_, i) => root('lottery-' + (i + 1), 'lottery')),
  root('resource-category', 'resourceCategory'),
  root('resource', 'resourceLink'),
  root('share', 'activityShare'),
  root('photo', 'media')
];
const byId = { orderBy: { id: 'asc' as const } };
const digestBytes = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const day = 86400000;

async function collision(tx: Tx, entry: Root): Promise<boolean> {
  const query = { where: { id: entry.entityId }, select: { id: true } };
  // A colliding, unowned row is never loaded as a content graph.
  switch (entry.kind) {
    case 'activity':
      return Boolean(await tx.activity.findUnique(query));
    case 'activitySeries':
      return Boolean(await tx.activitySeries.findUnique(query));
    case 'fixedTeam':
      return Boolean(await tx.fixedTeam.findUnique(query));
    case 'album':
      return Boolean(await tx.album.findUnique(query));
    case 'knowledgeCategory':
      return Boolean(await tx.knowledgeCategory.findUnique(query));
    case 'knowledgeArticle':
      return Boolean(await tx.knowledgeArticle.findUnique(query));
    case 'dailyPost':
      return Boolean(await tx.dailyPost.findUnique(query));
    case 'wish':
      return Boolean(await tx.wish.findUnique(query));
    case 'lottery':
      return Boolean(await tx.lottery.findUnique(query));
    case 'resourceCategory':
      return Boolean(await tx.resourceCategory.findUnique(query));
    case 'resourceLink':
      return Boolean(await tx.resourceLink.findUnique(query));
    case 'activityShare':
      return Boolean(await tx.activityShare.findUnique(query));
    case 'media':
      return false;
  }
}

/** Every scalar on each root and its children is hashed, including new user-created children.
 * No Account relation is included: credentials/phone/session material never enters a snapshot.
 * Collection ordering is explicit; intrinsic array order (e.g. mediaIds) is preserved. */
async function snapshot(tx: Tx, entry: Root): Promise<unknown> {
  const where = { id: entry.entityId };
  switch (entry.kind) {
    case 'activity':
      return tx.activity.findUnique({
        where,
        include: {
          seats: byId,
          registrations: { ...byId, include: { attendanceAppeals: byId } },
          commands: byId,
          events: { ...byId, include: { mockDelivery: true } },
          penalties: { ...byId, include: { appeals: byId, scoreChange: true } },
          completions: { ...byId, include: { scoreChange: true } },
          linkedAlbums: byId,
          publicShares: byId
        }
      });
    case 'activitySeries':
      return tx.activitySeries.findUnique({ where, include: { activities: byId, albums: byId } });
    case 'fixedTeam':
      return tx.fixedTeam.findUnique({
        where,
        include: {
          seats: byId,
          memberships: byId,
          applications: byId,
          commands: byId,
          notifications: byId,
          participationChanges: byId,
          sessions: {
            ...byId,
            include: {
              feedback: byId,
              members: { ...byId, include: { leave: true, participationChanges: byId } },
              substitutes: { ...byId, include: { participationChanges: byId } }
            }
          }
        }
      });
    case 'album':
      return tx.album.findUnique({
        where,
        include: {
          photos: {
            ...byId,
            include: {
              likes: { orderBy: { accountId: 'asc' } },
              comments: byId,
              audits: byId,
              notifications: byId
            }
          },
          comments: byId,
          audits: byId,
          notifications: byId
        }
      });
    case 'knowledgeCategory':
      return tx.knowledgeCategory.findUnique({ where, include: { articles: byId } });
    case 'knowledgeArticle':
      return tx.knowledgeArticle
        .findUnique({
          where,
          include: {
            versions: byId,
            contributions: { orderBy: { accountId: 'asc' } },
            comments: byId,
            images: byId,
            audits: byId
          }
        })
        .then(async (article) =>
          article
            ? {
                article,
                notifications: await tx.knowledgeNotification.findMany({
                  where: { comment: { articleId: entry.entityId } },
                  ...byId
                })
              }
            : null
        );
    case 'dailyPost':
      return tx.dailyPost
        .findUnique({
          where,
          include: {
            media: byId,
            comments: byId,
            likes: { orderBy: { accountId: 'asc' } },
            notifications: byId,
            audits: byId
          }
        })
        .then(async (post) =>
          post
            ? {
                post,
                commands: await tx.dailyCommand.findMany({
                  where: {
                    resultId: {
                      in: [
                        entry.entityId,
                        ...post.comments.map((comment) => comment.id),
                        ...post.media.map((media) => media.id)
                      ]
                    }
                  },
                  ...byId
                })
              }
            : null
        );
    case 'wish':
      return tx.wish.findUnique({
        where,
        include: {
          interests: { orderBy: { accountId: 'asc' } },
          comments: byId,
          conversion: true,
          notifications: byId,
          commands: { orderBy: [{ actorId: 'asc' }, { idempotencyKey: 'asc' }] }
        }
      });
    case 'lottery':
      return tx.lottery.findUnique({
        where,
        include: {
          entries: { orderBy: { accountId: 'asc' } },
          commands: { orderBy: [{ actorId: 'asc' }, { key: 'asc' }] },
          notifications: { orderBy: { eventKey: 'asc' } }
        }
      });
    case 'resourceCategory':
      return tx.resourceCategory.findUnique({ where, include: { resources: byId } });
    case 'resourceLink':
      return tx.resourceLink.findUnique({ where });
    case 'activityShare':
      return tx.activityShare.findUnique({ where, include: { media: byId, audits: byId, commands: byId } });
    case 'media':
      return null;
  }
}

async function safeDirectory(value: string, create: boolean): Promise<string> {
  if (!isAbsolute(value)) throw new LocalQcDataError('QC_MEDIA_PATH_MUST_BE_ABSOLUTE');
  const directory = resolve(value);
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalQcDataError('QC_UNSAFE_MEDIA_DIRECTORY');
  }
  if ((await realpath(directory)) !== directory) throw new LocalQcDataError('QC_UNSAFE_MEDIA_DIRECTORY');
  return directory;
}
type Variant = 'original' | 'preview' | 'thumbnail';
interface MediaFile {
  path: string;
  variant: Variant;
}
async function mediaFiles(options: LocalQcDataOptions, create: boolean): Promise<MediaFile[]> {
  const original = await safeDirectory(options.originalDirectory, create),
    derived = await safeDirectory(options.derivedDirectory, create);
  if (original === derived) throw new LocalQcDataError('QC_MEDIA_DIRECTORIES_MUST_DIFFER');
  return (['original', 'preview', 'thumbnail'] as const).map((variant) => ({
    variant,
    path: join(variant === 'original' ? original : derived, `${id('photo')}.${variant}`)
  }));
}
async function readFileReceipt(
  path: string,
  state: LocalQcFileReceipt['state'] = 'published'
): Promise<LocalQcFileReceipt> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 60 * 1024 * 1024)
      throw new LocalQcDataError('QC_UNSAFE_MEDIA_OBJECT');
    const bytes = await file.readFile();
    return { path, sha256: digestBytes(bytes), bytes: bytes.length, state };
  } finally {
    await file.close();
  }
}
async function readMedia(files: MediaFile[]): Promise<LocalQcFileReceipt[]> {
  return Promise.all(files.map((file) => readFileReceipt(file.path)));
}
async function residualReceipts(receipts: readonly LocalQcFileReceipt[]): Promise<LocalQcFileReceipt[]> {
  const result: LocalQcFileReceipt[] = [];
  for (const receipt of receipts) {
    // Include actual partial bytes, not the intended output length/hash, if a write failed midway.
    try {
      const handle = await open(receipt.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 60 * 1024 * 1024)
          throw new LocalQcDataError('QC_UNSAFE_MEDIA_OBJECT');
        const bytes = await handle.readFile();
        result.push({ ...receipt, sha256: digestBytes(bytes), bytes: bytes.length });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new LocalQcDataError('QC_MEDIA_RECEIPT_UNAVAILABLE', [], receipts);
    }
  }
  return result;
}
function mediaDigest(receipts: readonly LocalQcFileReceipt[], files: MediaFile[]): string {
  return localQcDigest(
    files.map((file) => {
      const receipt = receipts.find((item) => item.path === file.path);
      if (!receipt) throw new LocalQcDataError('QC_MEDIA_RECEIPT_MISSING');
      return { variant: file.variant, sha256: receipt.sha256, bytes: receipt.bytes };
    })
  );
}
async function syntheticPhoto(): Promise<PhotoOutput> {
  // Self-contained geometric artwork: no external URL, person, private image or font download.
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#e5eedb"/><rect x="48" y="48" width="210" height="210" rx="20" fill="#326846"/><circle cx="430" cy="150" r="98" fill="#b18d52"/><path d="M320 280 L550 280 L435 70 Z" fill="#93b4c0" opacity="0.8"/><rect x="0" y="302" width="640" height="98" fill="#ffffff"/><text x="32" y="342" font-family="sans-serif" font-size="24" fill="#263626">[QC-V1] SYNTHETIC GEOMETRY</text><text x="32" y="378" font-family="sans-serif" font-size="22" fill="#263626">[虚构QC-V1] 纯几何合成图</text></svg>`
  );
  const png = await sharp(svg).png().toBuffer();
  return processPhoto(png, `${label}几何图.png`);
}
async function writeMedia(
  files: MediaFile[],
  photo: PhotoOutput,
  receipts: LocalQcFileReceipt[]
): Promise<void> {
  // Publish with hard-link/no-overwrite. Only our successfully linked private staging name is removed.
  // On any error leave all remaining objects intact and report precise residual paths; never discard media.
  for (const file of files) {
    const staged = join(dirname(file.path), `.qc-stage-${randomUUID()}`),
      bytes = photo[file.variant];
    const handle = await open(
      staged,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    receipts.push({ path: staged, sha256: digestBytes(bytes), bytes: bytes.length, state: 'staged' });
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(staged, file.path);
    receipts.push({ path: file.path, sha256: digestBytes(bytes), bytes: bytes.length, state: 'published' });
    await unlink(staged);
    receipts.splice(
      receipts.findIndex((receipt) => receipt.path === staged),
      1
    );
  }
}

async function verifyBindings(tx: Tx, bindings: LocalQcBindings, anchor?: Date): Promise<void> {
  const ids = LOCAL_QC_SLOTS.map((slot) => bindings[slot]).sort();
  // Identity lock is compatible with lifecycle Account NO KEY UPDATE. Never load phone/password/session.
  for (const accountId of ids)
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id=${accountId} FOR NO KEY UPDATE`;
  const accounts = await tx.account.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      membership: true,
      adminRole: true,
      createdAt: true,
      localQcNamespace: true,
      localQcSlot: true,
      lotteryStatus: { select: { active: true } }
    }
  });
  const invalid = LOCAL_QC_SLOTS.filter((slot) => {
    const account = accounts.find((row) => row.id === bindings[slot]);
    return (
      !account ||
      account.localQcNamespace !== namespace ||
      account.localQcSlot !== slot ||
      account.membership !== (slot === 'friend' ? 'FRIEND' : 'MEMBER') ||
      account.adminRole !== (slot === 'admin' ? 'ADMIN' : 'NONE') ||
      account.lotteryStatus?.active !== true ||
      (anchor && account.createdAt > anchor)
    );
  });
  if (invalid.length) throw new LocalQcDataError('QC_BINDING_POLICY_CHANGED', invalid);
}

async function createGraph(tx: Tx, b: LocalQcBindings, anchor: Date, photo: PhotoOutput): Promise<void> {
  const A = b['member-a'],
    B = b['member-b'],
    F = b.friend,
    admin = b.admin;
  const at = (days: number) => new Date(+anchor + days * day),
    text = (value: string) => label + value;
  const fingerprint = (slot: string) =>
    localQcDigest({ manifest: LOCAL_QC_DATA_MANIFEST.version, slot, bindings: b, anchor });
  await tx.activitySeries.create({
    data: {
      id: id('series'),
      state: 'RECRUITING',
      weekdays: [new Date(+at(36) + BEIJING_OFFSET_MS).getUTCDay() || 7],
      durationMinutes: 120,
      totalPeriods: 2,
      createdAt: anchor
    }
  });
  for (const [slot, days, period] of [
    ['ordinary-active', 35, null],
    ['ordinary-history', 32, null],
    ['series-period-1', 36, 1],
    ['series-period-2', 43, 2],
    ['offline-active', 37, null]
  ] as const) {
    const offline = slot === 'offline-active',
      history = slot === 'ordinary-history';
    await tx.activity.create({
      data: {
        id: id(slot),
        organizerId: A,
        idempotencyKey: id(slot + ':publish'),
        requestFingerprint: fingerprint(slot),
        title: text(
          offline
            ? '线下散步练习'
            : period
              ? '长期活动第' + period + '期'
              : history
                ? '已取消活动记录'
                : '报名换位练习'
        ),
        description: text('纯虚构的本地QC样本；无真实活动安排。'),
        scene: offline ? 'OFFLINE' : 'GAME',
        mode: period ? 'SERIES' : 'SINGLE',
        category: 'SOCIAL',
        startsAt: at(days),
        endsAt: new Date(+at(days) + 7200000),
        registrationClosesAt: offline ? at(36) : period ? at(35) : null,
        location: offline ? text('虚构几何广场') : null,
        meetingInstructions: offline ? text('无需实际到场') : null,
        seriesId: period ? id('series') : null,
        periodNumber: period,
        createdAt: anchor,
        managementEnabledAt: anchor,
        attendanceEnabledAt: anchor,
        completionEnabledAt: offline ? null : anchor,
        cancelledAt: history ? anchor : null,
        cancellationReason: history ? 'ORGANIZER_CANCELLED' : null,
        revision: history ? 1 : 0
      }
    });
    for (let position = 0; position < 2; position++)
      await tx.activitySeat.create({
        data: { id: id(slot + ':seat:' + position), activityId: id(slot), position, kind: 'ANY' }
      });
  }
  for (const [slot, actor, status] of [
    ['ordinary-active', B, 'ACTIVE'],
    ['ordinary-history', B, 'CANCELLED'],
    ['series-period-1', B, 'ACTIVE'],
    ['offline-active', F, 'ACTIVE']
  ] as const) {
    await tx.activityRegistration.create({
      data: {
        id: id(slot + ':registration'),
        activityId: id(slot),
        accountId: actor,
        seatId: status === 'ACTIVE' ? id(slot + ':seat:0') : null,
        status,
        createdAt: anchor,
        exitedAt: status === 'CANCELLED' ? anchor : null,
        ...(status === 'CANCELLED'
          ? { seatSnapshot: { position: 0, kind: 'ANY', groupKey: null, role: null, job: null } }
          : {})
      }
    });
  }
  // Explicit new cancellation history/audit, not a fabricated past attendance or point event.
  await tx.activityCommand.create({
    data: {
      id: id('ordinary-history:cancel-audit'),
      activityId: id('ordinary-history'),
      actorId: A,
      idempotencyKey: id('ordinary-history:cancel-command'),
      requestFingerprint: fingerprint('ordinary-history:cancel'),
      kind: 'CANCEL',
      before: { revision: 0, cancelledAt: null },
      after: { revision: 1, cancelledAt: anchor.toISOString(), points: 0 },
      createdAt: anchor
    }
  });
  const roles = ['TANK', 'TANK', 'HEALER', 'HEALER', 'DAMAGE', 'DAMAGE', 'DAMAGE', 'DAMAGE'] as const;
  for (const slot of ['team-current', 'team-history'] as const) {
    const historical = slot === 'team-history';
    await tx.fixedTeam.create({
      data: {
        id: id(slot),
        creatorId: A,
        name: text(historical ? '已解散队伍记录' : '招募练习队'),
        description: text('纯虚构，无真实组队或QQ。'),
        commonTimes: text('未来排期仅供界面QC'),
        state: historical ? 'DISSOLVED' : 'ACTIVE',
        dissolvedAt: historical ? anchor : null,
        revision: historical ? 2 : 0,
        idempotencyKey: id(slot + ':create'),
        requestFingerprint: fingerprint(slot),
        createdAt: anchor
      }
    });
    for (let position = 0; position < 8; position++)
      await tx.teamSeat.create({
        data: {
          id: id(slot + ':seat:' + position),
          teamId: id(slot),
          position,
          kind: 'ROLE',
          role: roles[position]
        }
      });
    for (const [position, actor, job] of [
      [0, A, '骑士'],
      [1, B, '战士']
    ] as const)
      await tx.teamMembership.create({
        data: {
          id: id(slot + ':member:' + position),
          teamId: id(slot),
          accountId: actor,
          position,
          job,
          seatId: historical && position === 1 ? null : id(slot + ':seat:' + position),
          state: historical && position === 1 ? 'LEFT' : 'ACTIVE',
          joinedAt: anchor,
          leftAt: historical && position === 1 ? anchor : null
        }
      });
    if (historical) {
      for (const [kind, actor, before, after] of [
        ['LEAVE_TEAM', B, { memberState: 'ACTIVE' }, { memberState: 'LEFT' }],
        ['DISSOLVE_TEAM', A, { state: 'ACTIVE' }, { state: 'DISSOLVED' }]
      ] as const)
        await tx.teamCommand.create({
          data: {
            id: id(slot + ':' + kind.toLowerCase()),
            teamId: id(slot),
            actorId: actor,
            idempotencyKey: id(slot + ':' + kind.toLowerCase() + ':key'),
            requestFingerprint: fingerprint(slot + ':' + kind),
            kind,
            before,
            after,
            createdAt: anchor
          }
        });
    }
  }
  await tx.teamApplication.create({
    data: {
      id: id('team-current:application'),
      teamId: id('team-current'),
      seatId: id('team-current:seat:4'),
      accountId: F,
      job: '武士',
      note: text('申请练习，无真实组队'),
      createdAt: anchor
    }
  });
  for (const [slot, days, confirmed] of [
    ['session-confirmed', 39, true],
    ['session-proposed', 40, false]
  ] as const) {
    await tx.teamSession.create({
      data: {
        id: id(slot),
        teamId: id('team-current'),
        startsAt: at(days),
        endsAt: new Date(+at(days) + 7200000),
        state: confirmed ? 'CONFIRMED' : 'PROPOSED',
        confirmedAt: confirmed ? anchor : null,
        createdAt: anchor
      }
    });
    if (confirmed)
      for (const [position, actor, job] of [
        [0, A, '骑士'],
        [1, B, '战士']
      ] as const)
        await tx.teamSessionMember.create({
          data: {
            id: id(slot + ':member:' + position),
            sessionId: id(slot),
            timeVersion: 0,
            membershipId: id('team-current:member:' + position),
            accountId: actor,
            position,
            job,
            confirmedStartsAt: at(days),
            confirmedEndsAt: new Date(+at(days) + 7200000)
          }
        });
  }
  await tx.teamFeedback.create({
    data: {
      id: id('session-proposed:feedback'),
      sessionId: id('session-proposed'),
      timeVersion: 0,
      accountId: B,
      choice: 'CAN',
      updatedAt: anchor
    }
  });
  await tx.album.create({
    data: {
      id: id('album'),
      creatorId: F,
      name: text('合成几何相册'),
      description: text('只有合成几何图；未公开精选照片。'),
      primary: 'DAILY',
      uploadMode: 'AUTHOR',
      createdAt: anchor
    }
  });
  await tx.albumPhoto.create({
    data: {
      id: id('photo'),
      albumId: id('album'),
      uploaderId: F,
      batchId: id('photo:batch'),
      batchIndex: 0,
      digest: digestBytes(photo.original),
      originalName: text('几何合成图.png'),
      mime: photo.mime,
      bytes: photo.original.length,
      width: photo.width,
      height: photo.height,
      frames: photo.frames,
      description: text('纯几何合成，不含人物。'),
      createdAt: anchor
    }
  });
  await tx.knowledgeCategory.create({ data: { id: id('knowledge-category'), label: text('练习知识分类') } });
  const knowledgeBody = text('这是纯虚构的本地QC知识正文，可用于查看、编辑与评论。');
  await tx.knowledgeArticle.create({
    data: {
      id: id('knowledge'),
      authorId: A,
      submissionKey: id('knowledge:create'),
      requestFingerprint: fingerprint('knowledge'),
      title: text('知识编辑练习'),
      body: knowledgeBody,
      categoryId: id('knowledge-category'),
      createdAt: anchor,
      updatedAt: anchor
    }
  });
  await tx.knowledgeVersion.create({
    data: {
      id: id('knowledge:version:1'),
      articleId: id('knowledge'),
      editorId: A,
      body: knowledgeBody,
      number: 1,
      createdAt: anchor
    }
  });
  await tx.knowledgeContribution.create({
    data: { articleId: id('knowledge'), accountId: A, createdAt: anchor }
  });
  await tx.dailyPost.create({
    data: {
      id: id('daily'),
      authorId: A,
      body: text('这是一条纯虚构的文字动态，可用于编辑、删除和评论练习。'),
      mentions: [],
      createdAt: anchor
    }
  });
  for (const slot of ['wish-discussion', 'wish-linked'] as const)
    await tx.wish.create({
      data: {
        id: id(slot),
        authorId: A,
        title: text(slot === 'wish-discussion' ? '讨论心愿练习' : '已关联取消活动的心愿'),
        body: text('纯虚构的心愿讨论，不代表真实活动承诺。'),
        wantedContent: text('讨论练习'),
        convenientTime: text('无真实约定'),
        idempotencyKey: id(slot + ':create'),
        requestFingerprint: fingerprint(slot),
        activityId: slot === 'wish-linked' ? id('ordinary-history') : null,
        createdAt: anchor,
        updatedAt: anchor
      }
    });
  await tx.wishInterest.create({
    data: { wishId: id('wish-discussion'), accountId: B, createdAt: anchor, updatedAt: anchor }
  });
  await tx.wishConversion.create({
    data: {
      wishId: id('wish-linked'),
      actorId: A,
      activityId: id('ordinary-history'),
      idempotencyKey: id('ordinary-history:publish'),
      requestFingerprint: fingerprint('ordinary-history'),
      createdAt: anchor
    }
  });
  for (let number = 1; number <= 13; number++) {
    const slot = 'lottery-' + number;
    await tx.lottery.create({
      data: {
        id: id(slot),
        creatorId: A,
        idempotencyKey: id(slot + ':create'),
        fingerprint: fingerprint(slot),
        title: text('已取消抽奖练习 ' + number),
        kind: 'ORDINARY',
        mode: 'MANUAL',
        audience: 'MEMBER',
        prizes: [{ name: text('无实际奖品'), quantity: 1 }],
        drawAt: at(38),
        createdAt: anchor,
        state: 'CANCELLED',
        closedAt: anchor
      }
    });
  }
  await tx.resourceCategory.create({
    data: { id: id('resource-category'), name: text('站内练习资源'), createdAt: anchor, updatedAt: anchor }
  });
  await tx.resourceLink.create({
    data: {
      id: id('resource'),
      categoryId: id('resource-category'),
      name: text('知识页面练习入口'),
      purpose: text('仅指向本地知识页面，无外部服务。'),
      url: 'http://localhost:3100/knowledge/' + id('knowledge'),
      createdAt: anchor,
      updatedAt: anchor
    }
  });
  const shareTitle = text('纯文字活动回顾练习'),
    shareBody = text('这是已取消虚构活动的界面练习回顾。没有实际举办、参与或出勤；无真实人物、照片或奖品。');
  await tx.activityShare.create({
    data: {
      id: id('share'),
      activityId: id('ordinary-history'),
      creatorId: admin,
      title: shareTitle,
      body: shareBody,
      mediaIds: [],
      revision: 1,
      featuredAt: anchor,
      createdAt: anchor,
      updatedAt: anchor
    }
  });
  const publicView = {
    id: id('share'),
    title: shareTitle,
    body: shareBody,
    media: [],
    featuredAt: anchor.toISOString()
  };
  for (const action of ['CREATE', 'FEATURE'] as const) {
    await tx.activityShareAudit.create({
      data: {
        id: id('share:audit:' + action.toLowerCase()),
        shareId: id('share'),
        actorId: admin,
        action,
        reason: text(action === 'CREATE' ? '新建纯文字回顾' : '用户批准的本地文字精选'),
        before: action === 'CREATE' ? {} : { ...publicView, featuredAt: null },
        after: action === 'CREATE' ? { ...publicView, featuredAt: null } : publicView,
        createdAt: anchor
      }
    });
    await tx.activityShareCommand.create({
      data: {
        id: id('share:command:' + action.toLowerCase()),
        shareId: id('share'),
        actorId: admin,
        idempotencyKey: id('share:key:' + action.toLowerCase()),
        requestFingerprint: fingerprint('share:' + action),
        action,
        createdAt: anchor
      }
    });
  }
  // Existing comment/recipient semantics only: 7 new IN_APP interactions; no QQ, score or win kinds.
  for (const [number, actor] of [
    [1, B],
    [2, F],
    [3, admin]
  ] as const) {
    const commentId = id('knowledge:comment:' + number);
    await tx.knowledgeComment.create({
      data: {
        id: commentId,
        articleId: id('knowledge'),
        authorId: actor,
        body: text('知识评论练习 ' + number),
        mentions: [],
        submissionKey: id('knowledge:comment-key:' + number),
        createdAt: anchor
      }
    });
    await tx.knowledgeNotification.create({
      data: {
        id: id('knowledge:notice:' + number),
        recipientId: A,
        commentId,
        createdAt: anchor,
        messageReadAt: number === 1 ? anchor : null
      }
    });
  }
  for (const [number, actor] of [
    [1, B],
    [2, F]
  ] as const) {
    const commentId = id('daily:comment:' + number);
    await tx.dailyComment.create({
      data: {
        id: commentId,
        postId: id('daily'),
        authorId: actor,
        body: text('日常评论练习 ' + number),
        mentions: [],
        createdAt: anchor
      }
    });
    await tx.dailyNotification.create({
      data: {
        id: id('daily:notice:' + number),
        eventKey: `daily-comment:${commentId}:${A}`,
        postId: id('daily'),
        commentId,
        recipientId: A,
        kind: 'COMMENT',
        createdAt: anchor
      }
    });
    const wishCommentId = id('wish-discussion:comment:' + number);
    await tx.wishComment.create({
      data: {
        id: wishCommentId,
        wishId: id('wish-discussion'),
        authorId: actor,
        body: text('心愿讨论练习 ' + number),
        idempotencyKey: id('wish-discussion:comment-key:' + number),
        requestFingerprint: fingerprint('wish-discussion:comment:' + number),
        createdAt: anchor
      }
    });
    await tx.wishNotification.create({
      data: {
        id: id('wish-discussion:notice:' + number),
        eventKey: `wish-comment:${wishCommentId}:${A}`,
        wishId: id('wish-discussion'),
        commentId: wishCommentId,
        recipientId: A,
        kind: 'WISH_INTERACTION',
        createdAt: anchor
      }
    });
  }
}

export async function importLocalQcData(
  db: PrismaClient,
  bindings: QcBindings,
  options: LocalQcDataOptions
): Promise<LocalQcDataResult> {
  validateLocalQcBindings(bindings);
  if (!options) throw new LocalQcDataError('QC_LOCAL_TARGET_AUTHORIZATION_REQUIRED');
  const manifestHash = localQcDigest(LOCAL_QC_DATA_MANIFEST),
    filesWritten: LocalQcFileReceipt[] = [];
  try {
    return await db.$transaction(
      async (tx) => {
        // Caller guard must acquire lottery-compatible table/account fences before our account row locks.
        await assertQcTransaction(tx, { target: options.target ?? 'family', bindings, requireAdmin: true });
        const previous = await tx.localQcRun.findUnique({ where: { namespace } });
        if (
          previous &&
          (previous.manifestHash !== manifestHash ||
            localQcCanonical(previous.bindings) !== localQcCanonical(bindings))
        )
          throw new LocalQcDataError('QC_MANIFEST_OR_BINDINGS_CONFLICT');
        const anchor = previous?.anchor ?? options.anchor ?? new Date();
        if (!Number.isFinite(+anchor) || (!previous && Math.abs(Date.now() - +anchor) > 300000))
          throw new LocalQcDataError('QC_INVALID_INITIAL_ANCHOR');
        if (previous && options.anchor && +options.anchor !== +previous.anchor)
          throw new LocalQcDataError('QC_ANCHOR_CONFLICT');
        await verifyBindings(tx, bindings, previous ? undefined : anchor);
        const existingLedger = await tx.localQcRecord.findMany({
          where: { namespace },
          orderBy: { slot: 'asc' }
        });
        const files = await mediaFiles(options, !previous);
        if (previous) {
          const expectedSlots = new Set(roots.map((entry) => entry.slot));
          if (
            existingLedger.length !== roots.length ||
            existingLedger.some((entry) => !expectedSlots.has(entry.slot))
          )
            throw new LocalQcDataError('QC_LEDGER_INCOMPLETE');
          let receipts: LocalQcFileReceipt[];
          try {
            receipts = await readMedia(files);
          } catch {
            throw new LocalQcDataError('QC_MEDIA_CHANGED', ['photo']);
          }
          const conflicts: string[] = [];
          for (const entry of roots) {
            const saved = existingLedger.find((row) => row.slot === entry.slot)!;
            const current =
              entry.kind === 'media'
                ? mediaDigest(receipts, files)
                : localQcDigest(await snapshot(tx, entry));
            if (saved.kind !== entry.kind || saved.entityId !== entry.entityId || saved.digest !== current)
              conflicts.push(entry.slot);
          }
          if (conflicts.length) throw new LocalQcDataError('QC_USER_DATA_CHANGED', conflicts);
          return {
            namespace,
            anchor: anchor.toISOString(),
            manifestHash,
            replayed: true,
            records: existingLedger.map(({ slot, kind, entityId, digest }) => ({
              slot,
              kind,
              entityId,
              digest
            })),
            files: receipts
          };
        }
        if (existingLedger.length) throw new LocalQcDataError('QC_ORPHAN_LEDGER');
        for (const entry of roots)
          if (await collision(tx, entry)) throw new LocalQcDataError('QC_ENTITY_COLLISION', [entry.slot]);
        for (const file of files) {
          try {
            await lstat(file.path);
            throw new LocalQcDataError('QC_MEDIA_COLLISION', ['photo']);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        const photo = await syntheticPhoto();
        await writeMedia(files, photo, filesWritten);
        await createGraph(tx, bindings, anchor, photo);
        await tx.localQcRun.create({ data: { namespace, anchor, manifestHash, bindings: { ...bindings } } });
        const records = [];
        for (const entry of roots) {
          const digest =
            entry.kind === 'media'
              ? mediaDigest(filesWritten, files)
              : localQcDigest(await snapshot(tx, entry));
          const record = { namespace, slot: entry.slot, kind: entry.kind, entityId: entry.entityId, digest };
          await tx.localQcRecord.create({ data: record });
          records.push(record);
        }
        // Recheck local target/preflight and the four bound actors after final writes; no permissions granted.
        await assertQcTransaction(tx, { target: options.target ?? 'family', bindings, requireAdmin: true });
        await verifyBindings(tx, bindings);
        return {
          namespace,
          anchor: anchor.toISOString(),
          manifestHash,
          replayed: false,
          records,
          files: filesWritten
        };
      },
      { isolationLevel: 'ReadCommitted', timeout: 60000, maxWait: 5000 }
    );
  } catch (error) {
    // Transaction outcome may be unknown (lost acknowledgement). Preserve bytes and expose no DB error text.
    const retained = await residualReceipts(filesWritten);
    if (error instanceof LocalQcDataError)
      throw new LocalQcDataError(error.code, error.slots, [...retained, ...error.files]);
    const dbCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const safeCode = /^(?:LOCAL_)?QC_[A-Z0-9_]+$/.test(dbCode)
      ? dbCode
      : dbCode === 'P2002'
        ? 'QC_ENTITY_COLLISION'
        : 'QC_IMPORT_FAILED';
    throw new LocalQcDataError(retained.length ? 'QC_IMPORT_FAILED_MEDIA_RETAINED' : safeCode, [], retained);
  }
}
