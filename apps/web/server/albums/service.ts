import {
  PUBLIC_FEATURED_UPLOAD_NOTICE,
  publicityFromVisibility,
  visibilityFromPublicity,
  type AlbumPublicity
} from '../../content/album-publicity';
import { deletionIntent } from '../deletion-intent';
import { emitMessage } from '../messages/emit';
import { createHash, randomUUID } from 'node:crypto';
import type { MediaBudgetAttempt, MediaBoundAllocationTicket, Prisma } from '@artzoo/db';
import { AccountError, ACTIVITY_ALBUM_NAME_LIMIT, mediaBudgetPolicy } from '@artzoo/domain';
import { mediaBudgetError, mediaUploadPendingError } from '../media/budget-errors';
import { AccountService, lock, lockShared } from '../auth/service';
import { visibleCommentIds, commentSubtreeIds } from '../daily/comment-tree';
import { memberSelect, memberSummary } from '../members/service';
import { processPhoto, withPhotoSlot } from './processor';
import { albumStorage, albumCommentStorage, type PhotoStorage, type PhotoVariant } from './storage';
import {
  bad,
  containsMention,
  mentionText,
  denied,
  idInput,
  missing,
  optionalId,
  pageInput,
  primaryInput,
  revision,
  text,
  uploadFields,
  ALBUM_RULES,
  photoSelection,
  photoRotation,
  visibilityInput,
  featuredPoolInput,
  type AlbumView,
  type PhotoView,
  type CommentView
} from './contract';
type Tx = Prisma.TransactionClient;
type Body = Record<string, unknown>;
type AlbumMoveTargetReadContext = {
  accountId: string;
  albumIds: Set<string>;
  periodActivityId: string | null;
  activities: Map<string, { seriesId: string | null }>;
  periods: Map<string, { id: string; periodNumber: number | null; title: string }[] | null>;
  registered: Set<string>;
  registeredSeries: Set<string>;
  foreignPhotoAlbums: Set<string>;
};
const person = { id: true, displayName: true } as const;
const albumInclude = {
  creator: { select: person },
  category: true,
  coverPhoto: { select: { id: true, albumId: true, rotation: true, removedAt: true } },
  _count: {
    select: {
      photos: { where: { removedAt: null } },
      comments: { where: { removedAt: null, photoId: null } }
    }
  },
  photos: {
    where: { removedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { id: true, rotation: true }
  }
} as const satisfies Prisma.AlbumInclude;
type Album = Prisma.AlbumGetPayload<{ include: typeof albumInclude }>;
type AlbumViewPrefetch = {
  periods: { id: string; periodNumber: number | null; title: string; canUpload: boolean }[];
  canUpload: boolean;
  canDeleteSelf: boolean;
};
const photoInclude = {
  uploader: { select: memberSelect },
  _count: { select: { likes: true, comments: { where: { removedAt: null } } } }
} as const;
type Photo = Prisma.AlbumPhotoGetPayload<{ include: typeof photoInclude }>;
const conflict = () => {
  throw new AccountError('CONFLICT', '内容已更新，请刷新后再操作', 409);
};
const admin = (role: string) => role === 'ADMIN' || role === 'SUPER_ADMIN';
export class AlbumService {
  private readonly moveTargetReadContexts = new WeakMap<Tx, AlbumMoveTargetReadContext>();
  readonly storage: PhotoStorage;
  readonly commentStorage: PhotoStorage;
  constructor(
    readonly auth: AccountService,
    storage?: PhotoStorage,
    commentStorage?: PhotoStorage
  ) {
    this.storage = storage ?? albumStorage();
    // Existing injected byte ports still serve both paths unless explicitly separated.
    this.commentStorage = commentStorage ?? storage ?? albumCommentStorage();
  }
  private async account(tx: Tx, token?: string | null) {
    return this.auth.requireAccount(tx, token);
  }
  private async writer(tx: Tx, token?: string | null) {
    const actor = await this.account(tx, token);
    await lock(tx, `phone:${actor.account.phone}`);
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AccountSession" WHERE id = ${actor.id} FOR UPDATE`;
    const fresh = await this.account(tx, token);
    if (fresh.accountId !== actor.accountId) denied();
    return fresh;
  }
  private async album(tx: Tx, id: string, locked = false): Promise<Album> {
    id = idInput(id);
    if (locked) await lock(tx, `album:${id}`);
    const album = await tx.album.findUnique({ where: { id }, include: albumInclude });
    if (!album || album.removedAt) missing();
    return album;
  }
  private async photo(tx: Tx, albumId: string, id: string) {
    const photo = await tx.albumPhoto.findFirst({
      where: { id: idInput(id), albumId, removedAt: null },
      include: photoInclude
    });
    if (!photo) missing();
    return photo;
  }
  private async category(
    tx: Tx,
    primary: ReturnType<typeof primaryInput>,
    value: unknown,
    preserving = false
  ) {
    const id = optionalId(value);
    if (!id) return null;
    if (
      !(await tx.albumCategory.findFirst({ where: { id, primary, ...(preserving ? {} : { active: true }) } }))
    )
      bad('二级分类不存在或已停用');
    return id;
  }
  private async period(tx: Tx, album: Album, value: unknown) {
    const id = optionalId(value);
    if (!id) return null;
    if (!album.activityId) bad('此相册没有活动期次');
    if (
      (!album.seriesId && id !== album.activityId) ||
      !(await tx.activity.findFirst({
        where: { id, ...(album.seriesId ? { seriesId: album.seriesId } : {}) },
        select: { id: true }
      }))
    )
      bad('期次不属于此相册');
    return id;
  }
  private async canUpload(
    tx: Tx,
    album: Album,
    accountId: string,
    periodActivityId: string | null = null,
    locked = false
  ) {
    if (album.uploadsClosed) return false;
    if (album.uploadMode === 'AUTHOR') return album.creatorId === accountId;
    if (album.uploadMode === 'COMMUNITY') return true;
    const moveReads = !locked ? this.moveTargetReadContexts?.get(tx) : undefined;
    if (moveReads?.accountId === accountId && moveReads.albumIds.has(album.id))
      return periodActivityId
        ? moveReads.registered.has(periodActivityId)
        : album.seriesId
          ? moveReads.registeredSeries.has(album.seriesId)
          : moveReads.registered.has(album.activityId!);
    // Share the activity advisory locks used by registration/withdrawal, then re-read the roster.
    // All series periods in the established lock order: a concurrent roster change cannot race a successful upload.
    if (locked) {
      if (album.seriesId) {
        await lock(tx, `series:${album.seriesId}`);
        const periods = await tx.activity.findMany({
          where: { seriesId: album.seriesId },
          orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
          select: { id: true }
        });
        for (const period of periods) await lock(tx, `activity:${period.id}`);
      } else await lock(tx, `activity:${album.activityId}`);
    }
    return !!(await tx.activityRegistration.findFirst({
      where: {
        accountId,
        status: 'ACTIVE',
        exitedAt: null,
        ...(periodActivityId
          ? { activityId: periodActivityId }
          : album.seriesId
            ? { activity: { seriesId: album.seriesId } }
            : { activityId: album.activityId! })
      },
      select: { id: true }
    }));
  }
  private async listViews(tx: Tx, albums: Album[], actorId: string, role: string): Promise<AlbumView[]> {
    if (!albums.length) return [];
    const seriesIds = [...new Set(albums.filter((album) => album.seriesId).map((album) => album.seriesId!))];
    const activityIds = [
      ...new Set(albums.filter((album) => album.activityId).map((album) => album.activityId!))
    ];
    const periods =
      seriesIds.length || activityIds.length
        ? await tx.activity.findMany({
            where: {
              OR: [
                ...(seriesIds.length ? [{ seriesId: { in: seriesIds } }] : []),
                ...(activityIds.length ? [{ id: { in: activityIds } }] : [])
              ]
            },
            orderBy: { periodNumber: 'asc' },
            select: { id: true, seriesId: true, periodNumber: true, title: true }
          })
        : [];
    const byAlbum = new Map(
      albums.map((album) => [
        album.id,
        periods.filter((period) =>
          album.seriesId ? period.seriesId === album.seriesId : period.id === album.activityId
        )
      ])
    );
    const registrationIds = [
      ...new Set(
        albums
          .filter(
            (album) =>
              !album.uploadsClosed && album.uploadMode !== 'AUTHOR' && album.uploadMode !== 'COMMUNITY'
          )
          .flatMap((album) => [
            ...(album.activityId ? [album.activityId] : []),
            ...(byAlbum.get(album.id) ?? []).map((period) => period.id)
          ])
      )
    ];
    const registered = new Set(
      registrationIds.length
        ? (
            await tx.activityRegistration.findMany({
              where: {
                accountId: actorId,
                status: 'ACTIVE',
                exitedAt: null,
                activityId: { in: registrationIds }
              },
              select: { activityId: true }
            })
          ).map((registration) => registration.activityId)
        : []
    );
    // Removed photos still prevent self-delete under the established rule.
    const owned = albums.filter((album) => album.creatorId === actorId).map((album) => album.id);
    const foreignPhotoAlbums = new Set(
      owned.length
        ? (
            await tx.albumPhoto.groupBy({
              by: ['albumId'],
              where: { albumId: { in: owned }, uploaderId: { not: actorId } }
            })
          ).map((photo) => photo.albumId)
        : []
    );
    return Promise.all(
      albums.map((album) => {
        const albumPeriods = byAlbum.get(album.id) ?? [];
        const upload = (periodId?: string) => {
          if (album.uploadsClosed) return false;
          if (album.uploadMode === 'AUTHOR') return album.creatorId === actorId;
          if (album.uploadMode === 'COMMUNITY') return true;
          return periodId
            ? registered.has(periodId)
            : album.seriesId
              ? albumPeriods.some((period) => registered.has(period.id))
              : registered.has(album.activityId!);
        };
        return this.view(tx, album, actorId, role, {
          periods: album.activityId
            ? albumPeriods.map(({ id, periodNumber, title }) => ({
                id,
                periodNumber,
                title,
                canUpload: upload(id)
              }))
            : [],
          canUpload: upload(),
          canDeleteSelf: album.creatorId === actorId && !foreignPhotoAlbums.has(album.id)
        });
      })
    );
  }
  private async view(
    tx: Tx,
    album: Album,
    actorId: string,
    role: string,
    prefetched?: AlbumViewPrefetch
  ): Promise<AlbumView> {
    const isAdmin = admin(role),
      canManage = album.creatorId === actorId;
    const targetReads = !prefetched ? this.moveTargetReadContexts?.get(tx) : undefined;
    const moveReads =
      targetReads?.accountId === actorId && targetReads.albumIds.has(album.id) ? targetReads : undefined;
    const periods =
      !prefetched && album.activityId
        ? (moveReads?.periods.get(album.id) ??
          (await tx.activity.findMany({
            where: album.seriesId ? { seriesId: album.seriesId } : { id: album.activityId },
            orderBy: { periodNumber: 'asc' },
            select: { id: true, periodNumber: true, title: true }
          })))
        : [];
    const periodViews = prefetched ? prefetched.periods : [];
    for (const period of periods)
      periodViews.push({ ...period, canUpload: await this.canUpload(tx, album, actorId, period.id) });
    const canDeleteSelf = prefetched
      ? prefetched.canDeleteSelf
      : canManage &&
        !(moveReads
          ? moveReads.foreignPhotoAlbums.has(album.id)
          : await tx.albumPhoto.findFirst({
              where: { albumId: album.id, uploaderId: { not: actorId } },
              select: { id: true }
            }));
    const cover =
      album.coverPhoto && !album.coverPhoto.removedAt && album.coverPhoto.albumId === album.id
        ? album.coverPhoto
        : album.photos[0];
    return {
      id: album.id,
      name: album.name,
      description: album.description,
      primary: album.primary,
      category:
        album.category?.primary === album.primary
          ? {
              id: album.category.id,
              primary: album.category.primary,
              label: album.category.label,
              active: album.category.active
            }
          : null,
      creator: album.creator,
      uploadMode: album.uploadMode,
      uploadsClosed: album.uploadsClosed,
      revision: album.revision,
      activityId: album.activityId,
      seriesId: album.seriesId,
      canUpload: prefetched ? prefetched.canUpload : await this.canUpload(tx, album, actorId),
      canManage,
      canDelete: canDeleteSelf || isAdmin,
      canDeleteSelf,
      isAdmin,
      photoCount: album._count.photos,
      commentCount: album._count.comments,
      visibility: visibilityFromPublicity(album.publicity),
      coverPhotoId: album.coverPhotoId,
      coverRotation: cover?.rotation ?? 0,
      cover: cover ? `/api/album-photos/${cover.id}/media?variant=thumbnail` : null,
      periods: periodViews
    };
  }
  private async photoView(
    tx: Tx,
    photo: Photo,
    actorId: string,
    role: string,
    creatorId: string,
    publicity: AlbumPublicity,
    liked?: boolean
  ): Promise<PhotoView> {
    return {
      id: photo.id,
      albumId: photo.albumId,
      createdAt: photo.createdAt.toISOString(),
      description: photo.description,
      originalName: photo.originalName,
      uploader: memberSummary(photo.uploader),
      rotation: photo.rotation,
      width: photo.width,
      height: photo.height,
      frames: photo.frames,
      periodActivityId: photo.periodActivityId,
      revision: photo.revision,
      featuredAt: photo.featuredAt?.toISOString() ?? null,
      featuredPool: photo.featuredPool,
      featuredSelectedAt: photo.featuredSelectedAt?.toISOString() ?? null,
      canFeature: admin(role) && publicity === 'PUBLIC_FEATURED',
      featureUnavailableReason: !admin(role)
        ? '仅管理员可设置精选'
        : publicity !== 'PUBLIC_FEATURED'
          ? '仅公开可见相册的照片可设置精选或移池'
          : null,
      likes: photo._count.likes,
      comments: photo._count.comments,
      liked:
        liked ??
        !!(await tx.albumLike.findUnique({
          where: { photoId_accountId: { photoId: photo.id, accountId: actorId } }
        })),
      canEdit: photo.uploaderId === actorId,
      canMove: photo.uploaderId === actorId,
      canSetCover: creatorId === actorId,
      canRemove: photo.uploaderId === actorId || creatorId === actorId || admin(role),
      canRemoveSelf: photo.uploaderId === actorId || creatorId === actorId,
      isAdmin: admin(role),
      previewUrl: `/api/album-photos/${photo.id}/media?variant=preview`,
      thumbnailUrl: `/api/album-photos/${photo.id}/media?variant=thumbnail`
    };
  }
  private async likedPhotoIds(
    tx: Tx,
    photos: readonly { id: string }[],
    actorId: string
  ): Promise<Set<string>> {
    const likedIds = new Set<string>();
    // The overlay can include a large album. Bound each IN query as well as page reads.
    for (let offset = 0; offset < photos.length; offset += 500) {
      const likes = await tx.albumLike.findMany({
        where: {
          accountId: actorId,
          photoId: { in: photos.slice(offset, offset + 500).map((photo) => photo.id) }
        },
        select: { photoId: true }
      });
      for (const like of likes) likedIds.add(like.photoId);
    }
    return likedIds;
  }
  async categories(token?: string | null, all = false) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token);
      if (all && !admin(actor.account.adminRole)) denied();
      return {
        items: await tx.albumCategory.findMany({
          where: all ? {} : { active: true },
          orderBy: [{ primary: 'asc' }, { position: 'asc' }, { id: 'asc' }]
        }),
        uploadNotice: PUBLIC_FEATURED_UPLOAD_NOTICE
      };
    });
  }
  async saveCategory(body: Body, token?: string | null) {
    void body;
    return this.auth.transaction(async (tx) => {
      const actor = await this.writer(tx, token);
      if (!admin(actor.account.adminRole)) denied();
      return denied('相册分类管理已停用，现有分类和相册归属保留');
    });
  }
  async create(body: Body, token?: string | null) {
    const name = text(body.name, 100, true),
      description = text(body.description ?? '', 2000),
      primary = primaryInput(body.primary);
    if (Object.hasOwn(body, 'publicity')) bad('请仅使用可见范围设置');
    const activityId = optionalId(body.activityId),
      publicity = publicityFromVisibility(
        visibilityInput(body.visibility === undefined ? 'MEMBERS' : body.visibility)
      );
    if (!activityId && !['AUTHOR', 'COMMUNITY'].includes(String(body.uploadMode))) bad('请选择上传权限');
    return this.auth.transaction(async (tx) => {
      const actor = await this.writer(tx, token),
        categoryId = await this.category(tx, primary, body.categoryId);
      let seriesId: string | null = null,
        canonicalActivityId = activityId;
      if (activityId) {
        const activity = await tx.activity.findUnique({
          where: { id: activityId },
          select: { id: true, organizerId: true, seriesId: true, scene: true }
        });
        if (!activity) missing();
        if (activity.organizerId !== actor.accountId) denied('仅活动创建者可建立关联相册');
        if (primary !== (activity.scene === 'OFFLINE' ? 'OFFLINE' : 'GAME')) bad('分类与活动类型不一致');
        seriesId = activity.seriesId;
        await lock(tx, `album-link:${seriesId ?? activityId}`);
        if (seriesId)
          canonicalActivityId = (
            await tx.activity.findFirstOrThrow({
              where: { seriesId },
              orderBy: { periodNumber: 'asc' },
              select: { id: true }
            })
          ).id;
        const existing = await tx.album.findFirst({ where: seriesId ? { seriesId } : { activityId } });
        if (existing) {
          if (existing.removedAt) throw new AccountError('CONFLICT', '关联相册已被移除，请联系管理员', 409);
          return { id: existing.id };
        }
      }
      await this.account(tx, token);
      const album = await tx.album.create({
        data: {
          creatorId: actor.accountId,
          name,
          description,
          primary,
          categoryId,
          publicity,
          uploadMode: activityId ? 'ACTIVITY' : (body.uploadMode as 'AUTHOR' | 'COMMUNITY'),
          activityId: canonicalActivityId,
          seriesId
        }
      });
      // Only albums created under this policy opt in; historical albums are never backfilled.
      await tx.albumAudit.create({
        data: {
          albumId: album.id,
          actorId: actor.accountId,
          action: 'ALBUM_CREATED_INITIAL_COVER',
          reason: '新相册首次成功上传时初始化封面'
        }
      });
      return { id: album.id };
    });
  }
  async list(url: URL, token?: string | null) {
    const primary = url.searchParams.has('primary')
        ? primaryInput(url.searchParams.get('primary'))
        : undefined,
      categoryId = optionalId(url.searchParams.get('categoryId')),
      query = text(url.searchParams.get('query') ?? '', 100),
      page = pageInput(url);
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token);
      const rows = await tx.album.findMany({
        where: {
          removedAt: null,
          primary,
          ...(categoryId ? { categoryId } : {}),
          ...(query ? { name: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } } : {})
        },
        include: albumInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * 24,
        take: 25
      });
      return {
        items: await this.listViews(tx, rows.slice(0, 24), actor.accountId, actor.account.adminRole),
        hasMore: rows.length > 24
      };
    });
  }
  async forActivity(id: string, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token),
        activity = await tx.activity.findUnique({
          where: { id: idInput(id) },
          select: { id: true, seriesId: true }
        });
      if (!activity) missing();
      const album = await tx.album.findFirst({
        where: {
          removedAt: null,
          ...(activity.seriesId ? { seriesId: activity.seriesId } : { activityId: activity.id })
        },
        include: albumInclude
      });
      return { album: album ? await this.view(tx, album, actor.accountId, actor.account.adminRole) : null };
    });
  }
  async detail(id: string, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token);
      return this.view(tx, await this.album(tx, id), actor.accountId, actor.account.adminRole);
    });
  }
  private async preparePhotoRemovals(
    tx: Tx,
    albumId: string,
    ids: readonly string[],
    actorId: string,
    sourceAudits: Readonly<Record<string, string>>
  ) {
    if (!this.storage.boundPhotoNamespaces)
      return {
        storageRemovalIds: [] as string[],
        storageRetained: 0,
        storageLegacy: ids.length,
        storageRemovalAuthorizations: [] as { photoId: string; auditId: string }[]
      };
    const { prepareAlbumPhotoRemoval } = await import('@artzoo/media/stock-retirement');
    const prepared: string[] = [],
      authorizations: { photoId: string; auditId: string }[] = [];
    let retained = 0,
      legacy = 0;
    for (const id of ids) {
      const status = await prepareAlbumPhotoRemoval(tx, id, albumId);
      if (status === 'legacy') {
        legacy++;
        continue;
      }
      if (status === 'prepared') prepared.push(id);
      else retained++;
      const photo = await tx.albumPhoto.findUniqueOrThrow({ where: { id }, include: { album: true } });
      const audit = await tx.albumAudit.create({
        data: {
          albumId,
          photoId: id,
          actorId,
          action: 'PHOTO_PERMANENT_REMOVAL_REQUESTED',
          createdAt: this.auth.now(),
          reason: JSON.stringify({
            sourceAuditId: sourceAudits[id],
            revision: photo.revision,
            removedAt: photo.removedAt?.toISOString() ?? null,
            albumRemovedAt: photo.album.removedAt?.toISOString() ?? null
          })
        }
      });
      authorizations.push({ photoId: id, auditId: audit.id });
    }
    return {
      storageRemovalIds: prepared,
      storageRemovalAuthorizations: authorizations,
      storageRetained: retained,
      storageLegacy: legacy
    };
  }
  private async finishPhotoRemovals<T extends object>(result: T, signal?: AbortSignal) {
    const data = result as T & {
      storageRemovalIds?: string[];
      storageRetained?: number;
      storageLegacy?: number;
      storageRemovalAuthorizations?: { photoId: string; auditId: string }[];
    };
    if (!data.storageRemovalIds) return result;
    let completed = 0;
    let remainingIds = [...data.storageRemovalIds];
    const deadline = Date.now() + 15_000;
    const assertActive = () => {
      if (signal?.aborted || Date.now() >= deadline) throw Error('MEDIA_REMOVAL_BUDGET');
    };
    if (remainingIds.length && this.storage.boundPhotoNamespaces) {
      try {
        assertActive();
        const namespaces = await this.storage.boundPhotoNamespaces('album-photo');
        const { retireAlbumPhotoRemovals } = await import('@artzoo/media/stock-retirement');
        // One bounded round, not an unbounded sequence of 1000-photo chunks.
        const slice = remainingIds.slice(0, 1000);
        const current = await retireAlbumPhotoRemovals(this.auth.db, namespaces, slice, this.auth.now, {
          maxPhotos: 5,
          assertActive
        });
        completed = current.completed;
        remainingIds = [...current.remainingIds, ...remainingIds.slice(1000)];
      } catch {
        /* exact unconfirmed targets remain retryable */
      }
    }
    const pending = remainingIds.length;
    const preparedSet = new Set(data.storageRemovalIds);
    const authorizations = (data.storageRemovalAuthorizations ?? []).filter(
      (a) => !preparedSet.has(a.photoId) || remainingIds.includes(a.photoId)
    );
    return {
      ...result,
      storageReclamation: {
        status: pending ? 'pending' : data.storageRetained ? 'retained' : 'complete',
        completed,
        pending,
        retained: data.storageRetained ?? 0,
        legacy: data.storageLegacy ?? 0,
        targets: [...new Set([...remainingIds, ...authorizations.map((a) => a.photoId)])],
        authorizations
      }
    };
  }
  private async validateRemovalMarker(
    tx: Tx,
    album: { id: string; removedAt: Date | null },
    photo: { id: string; revision: number; removedAt: Date | null },
    marker: {
      id: string;
      action: string;
      photoId: string | null;
      albumId: string;
      actorId: string;
      createdAt: Date;
      reason: string;
    } | null
  ) {
    const id = photo.id,
      albumId = album.id;
    if (
      !marker ||
      marker.action !== 'PHOTO_PERMANENT_REMOVAL_REQUESTED' ||
      marker.photoId !== id ||
      marker.albumId !== albumId
    )
      bad('永久删除请求不匹配');
    let detail: {
      sourceAuditId?: string;
      revision?: number;
      removedAt?: string | null;
      albumRemovedAt?: string | null;
    };
    try {
      detail = JSON.parse(marker.reason);
    } catch {
      bad('永久删除请求不匹配');
    }
    if (
      !detail ||
      typeof detail.sourceAuditId !== 'string' ||
      detail.revision !== photo.revision ||
      detail.removedAt !== (photo.removedAt?.toISOString() ?? null) ||
      (detail.albumRemovedAt !== (album.removedAt?.toISOString() ?? null) &&
        !(detail.albumRemovedAt === null && !!photo.removedAt && !!album.removedAt))
    )
      bad('永久删除请求不匹配');
    const original = await tx.albumAudit.findUnique({ where: { id: idInput(detail.sourceAuditId) } });
    if (
      !original ||
      original.albumId !== albumId ||
      original.actorId !== marker.actorId ||
      original.createdAt > marker.createdAt ||
      !(
        (original.action === 'ALBUM_REMOVED' &&
          original.photoId === null &&
          !!album.removedAt &&
          !photo.removedAt) ||
        (['PHOTO_REMOVED', 'PHOTO_MODERATED'].includes(original.action) &&
          original.photoId === id &&
          !!photo.removedAt)
      )
    )
      bad('永久删除请求不匹配');
    return marker!;
  }
  /** Exact-album recovery reads only new explicit deletion markers, never old soft-deleted rows. */
  private async photoRemovalStatus(albumId: string, token?: string | null, cursor?: unknown) {
    const after = cursor === undefined || cursor === null ? undefined : idInput(cursor);
    return this.auth.transaction(async (tx) => {
      const actor = await this.writer(tx, token);
      await lock(tx, `album:${albumId}`);
      const album = await tx.album.findUnique({ where: { id: albumId } });
      if (!album) missing();
      const markers = await tx.albumAudit.findMany({
        where: {
          albumId,
          action: 'PHOTO_PERMANENT_REMOVAL_REQUESTED',
          photoId: { not: null },
          // A community uploader can recover their own explicit deletions without reading or
          // being blocked by another uploader's markers in the same album.
          ...(album.creatorId !== actor.accountId && !admin(actor.account.adminRole)
            ? { photo: { uploaderId: actor.accountId } }
            : {}),
          ...(after ? { id: { gt: after } } : {})
        },
        orderBy: { id: 'asc' },
        take: 101
      });
      const page = markers.slice(0, 100),
        authorizations: { photoId: string; auditId: string }[] = [];
      let retained = 0;
      const { inspectAlbumPhotoRemoval } = await import('@artzoo/media/stock-retirement');
      for (const marker of page) {
        if (!marker.photoId) bad('永久删除请求不匹配');
        const photo = await tx.albumPhoto.findUnique({ where: { id: marker.photoId } });
        if (!photo || photo.albumId !== albumId || (!photo.removedAt && !album.removedAt))
          bad('永久删除请求不匹配');
        if (
          photo.uploaderId !== actor.accountId &&
          album.creatorId !== actor.accountId &&
          !admin(actor.account.adminRole)
        )
          denied();
        await this.validateRemovalMarker(tx, album, photo, marker);
        const status = await inspectAlbumPhotoRemoval(tx, photo.id, albumId);
        if (status === 'legacy') bad('永久删除请求不匹配');
        const [ack] = await tx.$queryRaw<{ count: bigint }[]>`/*album-removal:status-ack*/
          SELECT COUNT(*)::bigint AS count FROM "MediaStoredComponent" c
          JOIN "MediaRetirementIntent" i ON i."componentId"=c.id
          JOIN "MediaStorageCredit" k ON k."componentId"=c.id AND k."intentId"=i.id AND k.bytes=c."chargedBytes"
          WHERE c."receiptScope"='album-photo' AND c."objectKey"=${'album-photo:' + photo.id}
            AND c.policy='PHOTO_VARIANT' AND i.state='ACKNOWLEDGED'
            AND c."storageIdentityFingerprint"=i."identityFingerprint"`;
        if (ack?.count === 3n) continue;
        if (status === 'retained') retained++;
        authorizations.push({ photoId: photo.id, auditId: marker.id });
      }
      const fresh = await this.account(tx, token);
      if (
        fresh.id !== actor.id ||
        fresh.accountId !== actor.accountId ||
        fresh.account.adminRole !== actor.account.adminRole ||
        fresh.account.membership !== actor.account.membership
      )
        denied('账号身份已变化，请重新登录');
      const nextCursor = markers.length > 100 ? page.at(-1)!.id : null;
      return {
        storageReclamation: {
          status:
            authorizations.length || nextCursor
              ? retained === authorizations.length && !nextCursor
                ? 'retained'
                : 'pending'
              : 'complete',
          completed: 0,
          pending: authorizations.length - retained,
          retained,
          legacy: 0,
          targets: authorizations.map((a) => a.photoId),
          authorizations,
          recovery: { nextCursor, path: `/api/albums/${albumId}` },
          legacyNotice: true
        }
      };
    });
  }
  /** Retry only the exact already-prepared deletion. This cannot enroll historical soft-deletions. */
  private async retryPhotoRemovals(
    albumId: string,
    ids: string[],
    token?: string | null,
    authorizations?: unknown,
    signal?: AbortSignal
  ) {
    if (ids.length > 1000 || !ids.length || new Set(ids).size !== ids.length) bad('重试目标无效');
    const result = await this.auth.transaction(async (tx) => {
      const actor = await this.writer(tx, token);
      await lock(tx, `album:${albumId}`);
      const album = await tx.album.findUnique({ where: { id: albumId } });
      if (!album) missing();
      const prepared: string[] = [],
        retainedAuthorizations: { photoId: string; auditId: string }[] = [];
      let retained = 0;
      for (const id of ids) {
        const photo = await tx.albumPhoto.findUnique({ where: { id: idInput(id) } });
        if (!photo || photo.albumId !== albumId || (!photo.removedAt && !album.removedAt)) missing();
        if (
          photo.uploaderId !== actor.accountId &&
          album.creatorId !== actor.accountId &&
          !admin(actor.account.adminRole)
        )
          denied();
        const [owned] = await tx.$queryRaw<{ count: bigint }[]>`/*album-removal:retry-owned*/
          SELECT COUNT(*)::bigint AS count FROM "MediaStoredComponent" c JOIN "MediaRetirementIntent" i ON i."componentId"=c.id
          WHERE c."receiptScope"='album-photo' AND c."objectKey"=${'album-photo:' + id}
            AND c.policy='PHOTO_VARIANT' AND c."storageIdentityFingerprint"=i."identityFingerprint"`;
        if (owned?.count === 3n) {
          prepared.push(id);
          continue;
        }
        const authorization = Array.isArray(authorizations)
          ? authorizations.find((a) => a && typeof a === 'object' && a.photoId === id)
          : null;
        if (!authorization || typeof authorization.auditId !== 'string')
          bad('此照片没有可重试的永久删除请求');
        const marker = await tx.albumAudit.findUnique({ where: { id: idInput(authorization.auditId) } });
        const validatedMarker = await this.validateRemovalMarker(tx, album, photo, marker);
        const status = await (
          await import('@artzoo/media/stock-retirement')
        ).prepareAlbumPhotoRemoval(tx, id, albumId);
        if (status === 'legacy') bad('此照片没有可重试的永久删除请求');
        retainedAuthorizations.push({ photoId: id, auditId: validatedMarker.id });
        if (status === 'prepared') prepared.push(id);
        else retained++;
      }
      const fresh = await this.account(tx, token);
      if (
        fresh.id !== actor.id ||
        fresh.accountId !== actor.accountId ||
        fresh.account.adminRole !== actor.account.adminRole ||
        fresh.account.membership !== actor.account.membership
      )
        denied('账号身份已变化，请重新登录');
      return {
        removed: true,
        storageRemovalIds: prepared,
        storageRetained: retained,
        storageRemovalAuthorizations: [
          ...retainedAuthorizations,
          ...prepared
            .filter((id) => !retainedAuthorizations.some((a) => a.photoId === id))
            .map((id) => ({ photoId: id, auditId: '' }))
        ]
      };
    });
    return this.finishPhotoRemovals(result, signal);
  }
  async update(id: string, body: Body, token?: string | null, signal?: AbortSignal) {
    if (body.action === 'storage-removal-status')
      return this.photoRemovalStatus(idInput(id), token, body.cursor);
    if (body.action === 'retry-storage-removal') {
      if (!Array.isArray(body.photoIds)) bad('重试目标无效');
      return this.retryPhotoRemovals(
        idInput(id),
        body.photoIds.map(idInput),
        token,
        body.removalAuthorizations,
        signal
      );
    }
    return this.auth
      .transaction(async (tx) => {
        const actor = await this.writer(tx, token),
          album = await this.album(tx, id, true);
        const fresh = await this.account(tx, token);
        if (
          fresh.id !== actor.id ||
          fresh.accountId !== actor.accountId ||
          fresh.account.adminRole !== actor.account.adminRole ||
          fresh.account.membership !== actor.account.membership
        )
          denied('账号身份已变化，请重新登录');
        if (album.creatorId !== actor.accountId && !admin(actor.account.adminRole)) denied();
        if (album.revision !== revision(body.revision)) conflict();
        if (body.action === 'remove') {
          const ordinaryEligible =
            album.creatorId === actor.accountId &&
            !(await tx.albumPhoto.findFirst({
              where: { albumId: album.id, uploaderId: { not: actor.accountId } },
              select: { id: true }
            }));
          const { reason } = deletionIntent(
            body,
            ordinaryEligible,
            admin(actor.account.adminRole),
            '创建者删除本人相册',
            500
          );
          const currentPhotos = await tx.albumPhoto.findMany({
            where: { albumId: album.id, removedAt: null },
            select: { id: true }
          });
          const now = this.auth.now();
          await tx.album.update({
            where: { id: album.id },
            data: { removedAt: now, revision: { increment: 1 } }
          });
          const audit = await tx.albumAudit.create({
            data: { albumId: album.id, actorId: actor.accountId, action: 'ALBUM_REMOVED', reason }
          });
          return {
            removed: true,
            ...(await this.preparePhotoRemovals(
              tx,
              album.id,
              currentPhotos.map((p) => p.id),
              actor.accountId,
              Object.fromEntries(currentPhotos.map((p) => [p.id, audit.id]))
            ))
          };
        }
        if (album.creatorId !== actor.accountId) denied('仅相册创建者可整理相册');
        if (Object.hasOwn(body, 'publicity')) bad('请仅使用可见范围设置');
        const publicity =
          body.visibility === undefined
            ? album.publicity
            : publicityFromVisibility(visibilityInput(body.visibility));
        const primary = primaryInput(body.primary ?? album.primary),
          requestedCategoryId =
            body.categoryId === undefined ? album.categoryId : optionalId(body.categoryId);
        // The hidden legacy category remains stored for history (and can reappear if the
        // primary is restored). Only an explicit category assignment is validated.
        const categoryId =
          body.categoryId === undefined
            ? album.categoryId
            : await this.category(
                tx,
                primary,
                requestedCategoryId,
                primary === album.primary && requestedCategoryId === album.categoryId
              );
        if (album.activityId && primary !== album.primary) bad('关联相册不能改变一级分类');
        if (typeof body.uploadsClosed !== 'boolean') bad('上传状态无效');
        const uploadMode = album.activityId ? 'ACTIVITY' : body.uploadMode;
        if (
          !['AUTHOR', 'COMMUNITY', 'ACTIVITY'].includes(String(uploadMode)) ||
          (!album.activityId && uploadMode === 'ACTIVITY')
        )
          bad('请选择上传权限');
        await tx.album.update({
          where: { id: album.id },
          data: {
            name: text(body.name, album.activityId || album.seriesId ? ACTIVITY_ALBUM_NAME_LIMIT : 100, true),
            description: text(body.description ?? '', 2000),
            primary,
            categoryId,
            publicity,
            uploadsClosed: body.uploadsClosed,
            uploadMode: uploadMode as Album['uploadMode'],
            revision: { increment: 1 }
          }
        });
        if (publicity !== album.publicity)
          await tx.albumAudit.create({
            data: {
              albumId: album.id,
              actorId: actor.accountId,
              action: 'ALBUM_PUBLICITY_CHANGED',
              reason:
                '相册创建者将可见范围改为' + (publicity === 'PUBLIC_FEATURED' ? '公开可见' : '仅成员可见')
            }
          });
        return { saved: true };
      })
      .then((result) => this.finishPhotoRemovals(result, signal));
  }
  async photos(id: string, url: URL, token?: string | null) {
    const page = pageInput(url),
      period = optionalId(url.searchParams.get('periodActivityId'));
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.account(tx, token),
          album = await this.album(tx, id);
        if (period) await this.period(tx, album, period);
        const where = { albumId: album.id, removedAt: null, ...(period ? { periodActivityId: period } : {}) };
        const [rows, total] = await Promise.all([
          tx.albumPhoto.findMany({
            where,
            include: photoInclude,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * 24,
            take: 25
          }),
          tx.albumPhoto.count({ where })
        ]);
        const visible = rows.slice(0, 24),
          likedIds = await this.likedPhotoIds(tx, visible, actor.accountId);
        return {
          items: await Promise.all(
            visible.map((row) =>
              this.photoView(
                tx,
                row,
                actor.accountId,
                actor.account.adminRole,
                album.creatorId,
                album.publicity,
                likedIds.has(row.id)
              )
            )
          ),
          hasMore: rows.length > 24,
          page,
          total,
          totalPages: Math.max(1, Math.ceil(total / 24))
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  // Explicit read-only metadata endpoint for the overlay; ordinary consumers keep 24-photo pages.
  async viewerPhotos(id: string, url: URL, token?: string | null) {
    const period = optionalId(url.searchParams.get('periodActivityId'));
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.account(tx, token),
          album = await this.album(tx, id);
        if (period) await this.period(tx, album, period);
        const rows = await tx.albumPhoto.findMany({
          where: { albumId: album.id, removedAt: null, ...(period ? { periodActivityId: period } : {}) },
          include: photoInclude,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
        });
        const likedIds = await this.likedPhotoIds(tx, rows, actor.accountId);
        return {
          items: await Promise.all(
            rows.map((row) =>
              this.photoView(
                tx,
                row,
                actor.accountId,
                actor.account.adminRole,
                album.creatorId,
                album.publicity,
                likedIds.has(row.id)
              )
            )
          )
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  private async command(
    id: string,
    kind: string,
    body: Body,
    token: string | null | undefined,
    mutate: (
      tx: Tx,
      album: Album,
      actor: Awaited<ReturnType<AccountService['requireAccount']>>
    ) => Promise<Prisma.InputJsonObject>,
    additionalAlbumIds: string[] = []
  ) {
    const submissionKey = idInput(body.submissionKey),
      albumId = idInput(id);
    const fingerprint = createHash('sha256').update(JSON.stringify({ albumId, kind, body })).digest('hex');
    return this.auth.transaction(async (tx) => {
      const actor = await this.writer(tx, token);
      await lock(tx, `album-command:${actor.accountId}:${submissionKey}`);
      const confirmActor = async () => {
        const fresh = await this.account(tx, token);
        if (
          fresh.id !== actor.id ||
          fresh.accountId !== actor.accountId ||
          fresh.account.adminRole !== actor.account.adminRole ||
          fresh.account.membership !== actor.account.membership
        )
          denied('账号身份已变化，请重新登录');
      };
      const previous = await tx.albumCommand.findUnique({
        where: { actorId_submissionKey: { actorId: actor.accountId, submissionKey } }
      });
      if (previous) {
        if (previous.fingerprint !== fingerprint) conflict();
        await confirmActor();
        return { ...(previous.result as Prisma.JsonObject), replayed: true };
      }
      for (const lockedId of [...new Set([albumId, ...additionalAlbumIds.map(idInput)])].sort())
        await lock(tx, `album:${lockedId}`);
      const album = await this.album(tx, albumId);
      await confirmActor();
      const result = await mutate(tx, album, actor);
      await tx.albumCommand.create({
        data: { actorId: actor.accountId, submissionKey, fingerprint, result, createdAt: this.auth.now() }
      });
      await confirmActor();
      return { ...result, replayed: false };
    });
  }
  async mutatePhotos(id: string, body: Body, token?: string | null, signal?: AbortSignal) {
    if (body.action === 'retry-storage-removal') {
      if (!Array.isArray(body.photoIds)) bad('重试目标无效');
      return this.retryPhotoRemovals(
        idInput(id),
        body.photoIds.map(idInput),
        token,
        body.removalAuthorizations,
        signal
      );
    }
    if (body.action === 'cover') {
      const photoId = idInput(body.photoId),
        expected = revision(body.revision),
        albumRevision = revision(body.albumRevision);
      return this.command(id, 'cover', body, token, async (tx, album, actor) => {
        if (album.creatorId !== actor.accountId) denied('仅相册创建者可以设置封面');
        const photo = await this.photo(tx, album.id, photoId);
        if (photo.revision !== expected || album.revision !== albumRevision) conflict();
        await tx.album.update({
          where: { id: album.id },
          data: { coverPhotoId: photo.id, revision: { increment: 1 } }
        });
        return { id: photo.id, saved: true, coverPhotoId: photo.id, albumRevision: album.revision + 1 };
      });
    }
    if (body.action === 'move') {
      const photoId = idInput(body.photoId),
        targetAlbumId = idInput(body.targetAlbumId),
        expected = revision(body.revision);
      if (targetAlbumId === idInput(id)) bad('请选择其他相册');
      return this.command(
        id,
        'move',
        body,
        token,
        async (tx, source, actor) => {
          const photo = await this.photo(tx, source.id, photoId);
          if (photo.uploaderId !== actor.accountId) denied('仅上传者可以移动自己的照片');
          if (photo.revision !== expected) conflict();
          const target = await this.album(tx, targetAlbumId);
          if (photo.periodActivityId && !(await this.canKeepPeriod(tx, target, photo.periodActivityId)))
            throw new AccountError('CONFLICT', '目标相册无法保留照片所属期次，请选择同一活动的相册', 409);
          if (!(await this.canUpload(tx, target, actor.accountId, photo.periodActivityId, true)))
            denied('目标相册当前不允许你上传');
          await this.account(tx, token);
          // Keep the old target-scoped upload key collision explicit, before changing any scope.
          if (
            await tx.albumPhoto.findFirst({
              where: {
                albumId: target.id,
                uploaderId: photo.uploaderId,
                batchId: photo.batchId,
                batchIndex: photo.batchIndex
              },
              select: { id: true }
            })
          )
            conflict();
          // A composite ON UPDATE CASCADE preserves all comment media in the same album scope.
          await tx.albumComment.updateMany({
            where: { photoId: photo.id, albumId: source.id },
            data: { albumId: target.id }
          });
          await tx.albumNotification.updateMany({
            where: { photoId: photo.id, albumId: source.id },
            data: { albumId: target.id }
          });
          await tx.albumPhoto.update({
            where: { id: photo.id },
            data: {
              albumId: target.id,
              uploadAlbumId: photo.uploadAlbumId ?? source.id,
              revision: { increment: 1 }
            }
          });
          await tx.album.update({
            where: { id: source.id },
            data: {
              ...(source.coverPhotoId === photo.id ? { coverPhotoId: null } : {}),
              revision: { increment: 1 }
            }
          });
          await tx.album.update({ where: { id: target.id }, data: { revision: { increment: 1 } } });
          await tx.albumAudit.create({
            data: {
              albumId: source.id,
              photoId: photo.id,
              actorId: actor.accountId,
              action: 'PHOTO_MOVED',
              reason: `移至相册 ${target.id}`
            }
          });
          return { id: photo.id, moved: true, albumId: target.id, revision: photo.revision + 1 };
        },
        [targetAlbumId]
      );
    }
    if (body.action === 'rotate') {
      const photoId = idInput(body.photoId),
        expected = revision(body.revision);
      photoRotation(0, body.direction);
      return this.command(id, 'rotate', body, token, async (tx, album, actor) => {
        const photo = await this.photo(tx, album.id, photoId);
        if (photo.uploaderId !== actor.accountId) denied('仅上传者可以旋转照片');
        if (photo.revision !== expected) conflict();
        const rotation = photoRotation(photo.rotation, body.direction);
        await tx.albumPhoto.update({
          where: { id: photo.id },
          data: { rotation, revision: { increment: 1 } }
        });
        return { id: photo.id, rotation, revision: photo.revision + 1 };
      });
    }
    if (body.action !== 'remove') bad('照片操作无效');
    const selected = photoSelection(body.photos);
    return this.command(id, 'remove-photos', body, token, async (tx, album, actor) => {
      // Validate the complete cross-page selection before the first mutation or audit.
      const photos = await tx.albumPhoto.findMany({
        where: { albumId: album.id, id: { in: selected.map((row) => row.id) }, removedAt: null }
      });
      if (photos.length !== selected.length) missing();
      const revisions = new Map(selected.map((row) => [row.id, row.revision]));
      for (const photo of photos) {
        if (
          photo.uploaderId !== actor.accountId &&
          album.creatorId !== actor.accountId &&
          !admin(actor.account.adminRole)
        )
          denied();
        if (photo.revision !== revisions.get(photo.id)) conflict();
      }
      const { moderate, reason } = deletionIntent(
        body,
        photos.every((photo) => photo.uploaderId === actor.accountId || album.creatorId === actor.accountId),
        admin(actor.account.adminRole),
        photos.some((photo) => photo.uploaderId !== actor.accountId)
          ? '相册创建者删除照片'
          : '上传者删除本人照片',
        500
      );
      const now = this.auth.now();
      await tx.albumPhoto.updateMany({
        where: { albumId: album.id, id: { in: selected.map((row) => row.id) }, removedAt: null },
        data: {
          removedAt: now,
          featuredAt: null,
          featuredPool: null,
          featuredSelectedAt: null,
          revision: { increment: 1 }
        }
      });
      const removalAudits = photos.map((photo) => ({ id: randomUUID(), photoId: photo.id }));
      await tx.albumAudit.createMany({
        data: photos.map((photo) => ({
          id: removalAudits.find((a) => a.photoId === photo.id)!.id,
          albumId: album.id,
          photoId: photo.id,
          actorId: actor.accountId,
          action: moderate ? 'PHOTO_MODERATED' : 'PHOTO_REMOVED',
          reason
        }))
      });
      if (album.coverPhotoId && selected.some((p) => p.id === album.coverPhotoId))
        await tx.album.update({ where: { id: album.id }, data: { coverPhotoId: null } });
      return {
        removed: true,
        count: selected.length,
        ...(await this.preparePhotoRemovals(
          tx,
          album.id,
          selected.map((p) => p.id),
          actor.accountId,
          Object.fromEntries(removalAudits.map((a) => [a.photoId, a.id]))
        ))
      };
    }).then((result) => this.finishPhotoRemovals(result, signal));
  }
  private async canKeepPeriod(tx: Tx, album: Album, periodActivityId: string) {
    if (!album.activityId) return false;
    if (!album.seriesId && periodActivityId !== album.activityId) return false;
    const moveReads = this.moveTargetReadContexts?.get(tx);
    if (moveReads && moveReads.periodActivityId === periodActivityId && moveReads.albumIds.has(album.id)) {
      const period = moveReads.activities.get(periodActivityId);
      return !!period && (!album.seriesId || period.seriesId === album.seriesId);
    }
    return !!(await tx.activity.findFirst({
      where: { id: periodActivityId, ...(album.seriesId ? { seriesId: album.seriesId } : {}) },
      select: { id: true }
    }));
  }
  private async prefetchMoveTargetReads(
    tx: Tx,
    rows: Album[],
    accountId: string,
    periodActivityId: string | null
  ): Promise<AlbumMoveTargetReadContext> {
    const sourcePeriod =
      periodActivityId &&
      rows.some((album) => album.activityId && (album.seriesId || album.activityId === periodActivityId))
        ? await tx.activity.findFirst({
            where: { id: periodActivityId },
            select: { id: true, seriesId: true }
          })
        : null;
    const compatible = periodActivityId
      ? rows.filter(
          (album) =>
            album.activityId &&
            sourcePeriod &&
            (album.seriesId ? album.seriesId === sourcePeriod.seriesId : album.activityId === sourcePeriod.id)
        )
      : rows;
    const registrationAlbums = compatible.filter(
      (album) => !album.uploadsClosed && album.uploadMode !== 'AUTHOR' && album.uploadMode !== 'COMMUNITY'
    );
    const registrationIds = [
      ...new Set(registrationAlbums.flatMap((album) => (album.activityId ? [album.activityId] : [])))
    ];
    const registrationSeries = [
      ...new Set(registrationAlbums.flatMap((album) => (album.seriesId ? [album.seriesId] : [])))
    ];
    const registrations =
      registrationIds.length || registrationSeries.length
        ? await tx.activityRegistration.findMany({
            where: {
              accountId,
              status: 'ACTIVE',
              exitedAt: null,
              OR: [
                ...(registrationIds.length ? [{ activityId: { in: registrationIds } }] : []),
                ...(registrationSeries.length ? [{ activity: { seriesId: { in: registrationSeries } } }] : [])
              ]
            },
            select: { activityId: true, activity: { select: { seriesId: true } } }
          })
        : [];
    const registered = new Set(registrations.map((registration) => registration.activityId));
    const registeredSeries = new Set(
      registrations.flatMap((registration) =>
        registration.activity.seriesId ? [registration.activity.seriesId] : []
      )
    );
    // Prune only auxiliary DTO reads. The existing ordered canKeepPeriod/canUpload
    // calls still make the final decision under this same RepeatableRead snapshot.
    const visible = compatible.filter((album) =>
      album.uploadsClosed
        ? false
        : album.uploadMode === 'AUTHOR'
          ? album.creatorId === accountId
          : album.uploadMode === 'COMMUNITY'
            ? true
            : periodActivityId
              ? registered.has(periodActivityId)
              : album.seriesId
                ? registeredSeries.has(album.seriesId)
                : registered.has(album.activityId!)
    );
    const seriesIds = [
      ...new Set(visible.flatMap((album) => (album.activityId && album.seriesId ? [album.seriesId] : [])))
    ];
    const activityIds = [
      ...new Set(visible.flatMap((album) => (album.activityId ? [album.activityId] : [])))
    ];
    const activities =
      seriesIds.length || activityIds.length
        ? await tx.activity.findMany({
            where: {
              OR: [
                ...(seriesIds.length ? [{ seriesId: { in: seriesIds } }] : []),
                ...(activityIds.length ? [{ id: { in: activityIds } }] : [])
              ]
            },
            orderBy: { periodNumber: 'asc' },
            select: { id: true, seriesId: true, periodNumber: true, title: true }
          })
        : [];
    const owned = visible
      .filter((album) => album.seriesId && album.creatorId === accountId)
      .map((album) => album.id);
    const foreignPhotoAlbums = new Set(
      owned.length
        ? (
            await tx.albumPhoto.groupBy({
              by: ['albumId'],
              where: { albumId: { in: owned }, uploaderId: { not: accountId } }
            })
          ).map((photo) => photo.albumId)
        : []
    );
    return {
      accountId,
      albumIds: new Set(rows.map((album) => album.id)),
      periodActivityId,
      activities: new Map([
        ...activities.map((period) => [period.id, { seriesId: period.seriesId }] as const),
        ...(sourcePeriod ? [[sourcePeriod.id, { seriesId: sourcePeriod.seriesId }] as const] : [])
      ]),
      periods: new Map(
        rows.map((album) => {
          const periods = activities.filter((period) =>
            album.seriesId ? period.seriesId === album.seriesId : period.id === album.activityId
          );
          // Preserve the old per-series query position/order when legacy values tie.
          const ambiguous =
            album.seriesId && new Set(periods.map((p) => p.periodNumber)).size < periods.length;
          return [
            album.id,
            ambiguous ? null : periods.map(({ id, periodNumber, title }) => ({ id, periodNumber, title }))
          ];
        })
      ),
      registered,
      registeredSeries,
      foreignPhotoAlbums
    };
  }
  async moveTargets(id: string, url: URL, token?: string | null) {
    const photoId = idInput(url.searchParams.get('photoId'));
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.account(tx, token),
          source = await this.album(tx, id),
          photo = await this.photo(tx, source.id, photoId);
        if (photo.uploaderId !== actor.accountId) denied('仅上传者可以移动自己的照片');
        const rows = await tx.album.findMany({
          where: { removedAt: null, id: { not: source.id }, uploadsClosed: false },
          include: albumInclude,
          orderBy: [{ name: 'asc' }, { id: 'asc' }]
        });
        if (rows.length)
          this.moveTargetReadContexts.set(
            tx,
            await this.prefetchMoveTargetReads(tx, rows, actor.accountId, photo.periodActivityId)
          );
        try {
          const entries: ({ view: AlbumView } | { batchIndex: number })[] = [],
            batched: Album[] = [];
          for (const target of rows) {
            if (photo.periodActivityId && !(await this.canKeepPeriod(tx, target, photo.periodActivityId)))
              continue;
            if (await this.canUpload(tx, target, actor.accountId, photo.periodActivityId)) {
              // Keep series period queries in their original position, including legacy NULL ordering.
              if (target.seriesId)
                entries.push({ view: await this.view(tx, target, actor.accountId, actor.account.adminRole) });
              else entries.push({ batchIndex: batched.push(target) - 1 });
            }
          }
          const views = await this.listViews(tx, batched, actor.accountId, actor.account.adminRole);
          return {
            items: entries.map((entry) => ('view' in entry ? entry.view : views[entry.batchIndex]!))
          };
        } finally {
          this.moveTargetReadContexts.delete(tx);
        }
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  async upload(id: string, body: Body, input: Buffer, name: string, token?: string | null) {
    const fields = uploadFields(body),
      originalName = text(name.replace(/[\u0000-\u001f\u007f/\\]/g, '_'), 255, true),
      digest = createHash('sha256').update(input).digest('hex');
    const budgetEnabled = (process.env.ARTZOO_MEDIA_BUDGET_ENABLED ?? '0') !== '0';
    let attempt: MediaBudgetAttempt | undefined;
    let photoAllocation: MediaBoundAllocationTicket | undefined;
    let photoNamespaces: Awaited<ReturnType<NonNullable<PhotoStorage['writePhotoNamespaces']>>> | undefined;
    const photoProofs: import('@artzoo/media/stock-retirement').MediaWriteProof[] = [];
    const retainUnknown = async () => {
      try {
        await attempt?.unknown();
      } catch {
        console.warn('Album photo budget outcome remains uncertain');
      }
    };
    // This read-only replay check uses the same lock/permission sequence as publication.
    // It must precede the decoder so a previously committed request remains replayable.
    const inspect = async (tx: Tx, initial = false) => {
      const actor = await this.writer(tx, token),
        album = await this.album(tx, id, true);
      const periodActivityId = await this.period(tx, album, fields.periodActivityId);
      if (!(await this.canUpload(tx, album, actor.accountId, periodActivityId, true)))
        denied(initial ? '此相册当前不允许你上传' : '上传权限已变化，请刷新相册');
      await this.account(tx, token);
      const existing = await tx.albumPhoto.findFirst({
        where: {
          uploaderId: actor.accountId,
          batchId: fields.batchId,
          batchIndex: fields.batchIndex,
          OR: [{ albumId: album.id, uploadAlbumId: null }, { uploadAlbumId: album.id }]
        }
      });
      if (
        existing &&
        (existing.digest !== digest || existing.periodActivityId !== periodActivityId || existing.removedAt)
      )
        conflict();
      await this.account(tx, token);
      return { actor, album, periodActivityId, existing };
    };
    let preflight: Awaited<ReturnType<typeof inspect>> | undefined;
    const replay = await this.auth.transaction(async (tx) => {
      const inspected = await inspect(tx, true),
        { existing } = inspected;
      if (budgetEnabled) preflight = inspected;
      // Filename changes retain the old format-validation path; only the exact
      // original filename can skip the current decoder/sanitizer.
      return existing && existing.originalName === originalName ? { id: existing.id, replayed: true } : null;
    });
    if (replay) return replay;
    // ON replay keeps changed-filename validation and its final authorization, but needs no new bytes.
    if (budgetEnabled && preflight?.existing) {
      await withPhotoSlot(() => processPhoto(input, originalName));
      preflight = await this.auth.transaction((tx) => inspect(tx));
      if (preflight.existing) return { id: preflight.existing.id, replayed: true };
    }
    const policy = budgetEnabled ? mediaBudgetPolicy(process.env) : null;
    let budgetPhotoId: string | undefined, output: Awaited<ReturnType<typeof processPhoto>>;
    if (policy?.enabled) {
      if (!input.length || input.length > ALBUM_RULES.maxBytes) bad('每张图片最多30MiB');
      budgetPhotoId = randomUUID();
      try {
        const prepared = await (
          await import('@artzoo/db')
        )
          .createMediaBudgetAdapter(this.auth.db, policy, this.auth.now)
          .prepare({
            scope: 'album-photo',
            operationKey: `${preflight!.album.id}:${preflight!.actor.accountId}:${fields.batchId}:${fields.batchIndex}`,
            fingerprint: createHash('sha256')
              .update(digest)
              .update('\0')
              .update(JSON.stringify(preflight!.periodActivityId))
              .digest('hex'),
            accountId: preflight!.actor.accountId,
            rawBytes: BigInt(input.length),
            objectIdentity: `album-photo:${budgetPhotoId}`
          });
        if (prepared.kind !== 'owner') {
          preflight = await this.auth.transaction((tx) => inspect(tx));
          if (preflight.existing && preflight.existing.originalName !== originalName) {
            await withPhotoSlot(() => processPhoto(input, originalName));
            preflight = await this.auth.transaction((tx) => inspect(tx));
          }
          if (preflight.existing) return { id: preflight.existing.id, replayed: true };
          throw mediaUploadPendingError();
        }
        attempt = prepared.attempt;
      } catch (error) {
        throw mediaBudgetError(error);
      }
    }
    try {
      output = await withPhotoSlot(() => processPhoto(input, originalName));
      if (attempt) {
        if (this.storage.writePhotoNamespaces || this.storage.boundPhotoNamespaces) {
          photoNamespaces = await (this.storage.writePhotoNamespaces ??
            this.storage.boundPhotoNamespaces)!.call(this.storage, 'album-photo');
          photoAllocation = await attempt.allocateBoundComponents({
            kind: 'photo',
            scope: 'album-photo',
            originalBytes: BigInt(output.original.length),
            previewBytes: BigInt(output.preview.length),
            thumbnailBytes: BigInt(output.thumbnail.length),
            contentHashes: {
              original: createHash('sha256').update(output.original).digest('hex'),
              preview: createHash('sha256').update(output.preview).digest('hex'),
              thumbnail: createHash('sha256').update(output.thumbnail).digest('hex')
            }
          });
        } else
          await attempt.allocate(
            BigInt(output.original.length) + BigInt(output.preview.length) + BigInt(output.thumbnail.length)
          );
      }
    } catch (error) {
      if (!attempt) throw error;
      try {
        await attempt.failBeforePersistence();
      } catch {
        console.warn('Album photo prewrite budget cleanup deferred');
      }
      throw mediaBudgetError(error);
    }
    const photoId = budgetPhotoId ?? randomUUID();
    if (attempt) {
      // Even a lost begin acknowledgement may be durable. Never release after this call starts.
      try {
        await attempt.begin();
      } catch (error) {
        await retainUnknown();
        throw mediaBudgetError(error);
      }
    }
    try {
      await this.storage.put(photoId, output);
      if (photoNamespaces && photoAllocation)
        for (const variant of ['original', 'preview', 'thumbnail'] as const)
          photoProofs.push(
            await photoNamespaces[variant === 'original' ? 'original' : 'derived'].capture(
              photoId,
              ('photo-' + variant) as 'photo-original' | 'photo-preview' | 'photo-thumbnail',
              createHash('sha256').update(output[variant]).digest('hex'),
              BigInt(output[variant].length)
            )
          );
    } catch (error) {
      if (!attempt) throw error;
      await retainUnknown();
      throw mediaBudgetError(error);
    }
    try {
      return await this.auth
        .transaction(async (tx) => {
          const { actor, album, periodActivityId, existing } = await inspect(tx);
          if (existing) return { id: existing.id, replayed: true };
          if (
            await tx.albumPhoto.findUnique({
              where: {
                albumId_uploaderId_batchId_batchIndex: {
                  albumId: album.id,
                  uploaderId: actor.accountId,
                  batchId: fields.batchId,
                  batchIndex: fields.batchIndex
                }
              },
              select: { id: true }
            })
          )
            conflict();
          // The album lock serializes first uploads, cover selection and photo moves.
          // Include removed/moved uploads in the history check so an emptied album never reinitializes.
          const validCover =
            album.coverPhoto && !album.coverPhoto.removedAt && album.coverPhoto.albumId === album.id;
          const existingCover = validCover ? null : album.photos[0];
          const initializeCover =
            !album.coverPhotoId &&
            !!(await tx.albumAudit.findFirst({
              where: { albumId: album.id, action: 'ALBUM_CREATED_INITIAL_COVER' },
              select: { id: true }
            })) &&
            !(await tx.albumPhoto.findFirst({
              where: { OR: [{ albumId: album.id }, { uploadAlbumId: album.id }] },
              select: { id: true }
            }));
          await tx.albumPhoto.create({
            data: {
              id: photoId,
              albumId: album.id,
              uploaderId: actor.accountId,
              ...fields,
              periodActivityId,
              digest,
              originalName,
              mime: output.mime,
              // digest remains the original-request identity; bytes describes stored original.
              bytes: output.original.length,
              width: output.width,
              height: output.height,
              frames: output.frames
            }
          });
          // Freeze the cover already displayed before this upload, including legacy implicit covers.
          // No rows are touched outside an actual successful new upload.
          if (existingCover || initializeCover)
            await tx.album.update({
              where: { id: album.id },
              data: { coverPhotoId: existingCover?.id ?? photoId, revision: { increment: 1 } }
            });
          if (attempt) {
            await attempt.commit(tx);
            if (photoAllocation)
              await (
                await import('@artzoo/media/stock-retirement')
              ).bindAlbumPhotoWrite(tx, photoAllocation, actor.accountId, photoId, photoProofs);
            const fresh = await this.account(tx, token);
            if (
              fresh.id !== actor.id ||
              fresh.accountId !== actor.accountId ||
              this.auth.now() >= fresh.expiresAt
            )
              throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          }
          return { id: photoId, replayed: false };
        })
        .then(async (result) => {
          if (result.replayed) {
            await this.storage.discardUncommitted(photoId).catch(() => undefined);
            if (attempt) await retainUnknown();
          }
          return result;
        });
    } catch (error) {
      if (attempt) await retainUnknown();
      // ON cannot treat a temporarily absent row as proof that an uncertain COMMIT will never finish.
      // Preserve the original confirmation-based cleanup only while budgets are OFF.
      if (!policy?.enabled) {
        try {
          if (!(await this.auth.db.albumPhoto.findUnique({ where: { id: photoId }, select: { id: true } })))
            await this.storage.discardUncommitted(photoId);
        } catch {
          console.warn('Uncommitted photo cleanup deferred');
        }
      }
      throw attempt ? mediaBudgetError(error) : error;
    }
  }
  async updatePhoto(id: string, body: Body, token?: string | null, signal?: AbortSignal) {
    if (body.action === 'retry-storage-removal') {
      const photo = await this.auth.db.albumPhoto.findUnique({
        where: { id: idInput(id) },
        select: { albumId: true }
      });
      if (!photo) missing();
      return this.retryPhotoRemovals(photo.albumId, [idInput(id)], token, body.removalAuthorizations, signal);
    }
    return this.auth
      .transaction(async (tx) => {
        const actor = await this.writer(tx, token),
          pointer = await tx.albumPhoto.findUnique({ where: { id: idInput(id) }, select: { albumId: true } });
        if (!pointer) missing();
        const album = await this.album(tx, pointer.albumId, true),
          photo = await this.photo(tx, album.id, id);
        await this.account(tx, token);
        if (photo.revision !== revision(body.revision)) conflict();
        if (body.action === 'edit') {
          if (photo.uploaderId !== actor.accountId) denied();
          const periodActivityId = await this.period(tx, album, body.periodActivityId);
          await tx.albumPhoto.update({
            where: { id: photo.id },
            data: { description: text(body.description, 2000), periodActivityId, revision: { increment: 1 } }
          });
          return { saved: true };
        }
        if (body.action === 'feature' || body.action === 'unfeature' || body.action === 'featured-pool') {
          const fresh = await this.account(tx, token);
          if (
            fresh.id !== actor.id ||
            fresh.accountId !== actor.accountId ||
            fresh.account.adminRole !== actor.account.adminRole ||
            fresh.account.membership !== actor.account.membership
          )
            denied('账号身份已变化，请重新登录');
          if (!admin(fresh.account.adminRole)) denied();
          if (body.action === 'unfeature') {
            const reason = text(body.reason, 500, true);
            await tx.albumPhoto.update({
              where: { id: photo.id },
              data: {
                featuredAt: null,
                featuredPool: null,
                featuredSelectedAt: null,
                revision: { increment: 1 }
              }
            });
            await tx.albumAudit.create({
              data: {
                albumId: album.id,
                photoId: photo.id,
                actorId: actor.accountId,
                action: 'PHOTO_UNFEATURED',
                reason
              }
            });
            return { saved: true };
          }
          if (album.publicity !== 'PUBLIC_FEATURED')
            throw new AccountError('CONFLICT', '仅公开可见相册的照片可设置精选或移池', 409);
          const now = this.auth.now();
          if (body.action === 'feature') {
            if (photo.featuredAt || photo.featuredPool) conflict();
            await tx.albumPhoto.update({
              where: { id: photo.id },
              data: {
                featuredAt: now,
                featuredPool: 'CANDIDATE',
                featuredSelectedAt: null,
                revision: { increment: 1 }
              }
            });
            await tx.albumAudit.create({
              data: {
                albumId: album.id,
                photoId: photo.id,
                actorId: actor.accountId,
                action: 'PHOTO_FEATURED',
                reason: '管理员设为精选，加入备选池'
              }
            });
          } else {
            const pool = featuredPoolInput(body.pool);
            if (!photo.featuredAt || !photo.featuredPool || photo.featuredPool === pool) conflict();
            await tx.albumPhoto.update({
              where: { id: photo.id },
              data: {
                featuredPool: pool,
                featuredSelectedAt: pool === 'SELECTED' ? now : null,
                revision: { increment: 1 }
              }
            });
            await tx.albumAudit.create({
              data: {
                albumId: album.id,
                photoId: photo.id,
                actorId: actor.accountId,
                action: pool === 'SELECTED' ? 'PHOTO_FEATURED_SELECTED' : 'PHOTO_FEATURED_CANDIDATE',
                reason:
                  pool === 'SELECTED'
                    ? '管理员将精选照片从备选移至入选池'
                    : '管理员将精选照片从入选退回备选池'
              }
            });
          }
          return { saved: true };
        }
        if (body.action !== 'remove') bad('照片操作无效');
        if (
          photo.uploaderId !== actor.accountId &&
          album.creatorId !== actor.accountId &&
          !admin(actor.account.adminRole)
        )
          denied();
        const { moderate, reason } = deletionIntent(
          body,
          photo.uploaderId === actor.accountId || album.creatorId === actor.accountId,
          admin(actor.account.adminRole),
          photo.uploaderId === actor.accountId ? '上传者删除本人照片' : '相册创建者删除照片',
          500
        );
        await tx.albumPhoto.update({
          where: { id: photo.id },
          data: {
            removedAt: this.auth.now(),
            featuredAt: null,
            featuredPool: null,
            featuredSelectedAt: null,
            revision: { increment: 1 }
          }
        });
        const audit = await tx.albumAudit.create({
          data: {
            albumId: album.id,
            photoId: photo.id,
            actorId: actor.accountId,
            action: moderate ? 'PHOTO_MODERATED' : 'PHOTO_REMOVED',
            reason
          }
        });
        if (album.coverPhotoId === photo.id)
          await tx.album.update({ where: { id: album.id }, data: { coverPhotoId: null } });
        return {
          removed: true,
          ...(await this.preparePhotoRemovals(tx, album.id, [photo.id], actor.accountId, {
            [photo.id]: audit.id
          }))
        };
      })
      .then((result) => this.finishPhotoRemovals(result, signal));
  }
  async readMedia(id: string, variant: PhotoVariant, token?: string | null) {
    if (!['original', 'preview', 'thumbnail'].includes(variant)) bad('图片版本无效');
    const retry = Symbol('album-photo-moved');
    const authorize = async (expected?: { id: string; accountId: string }) => {
      let expectedActor = expected;
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await this.auth.transaction(async (tx) => {
          const pointer = await tx.albumPhoto.findUnique({
            where: { id: idInput(id) },
            select: { albumId: true }
          });
          // A supplied invalid/expired session is never anonymous public access.
          const actor = token != null || variant === 'original' ? await this.account(tx, token) : null;
          if (
            expectedActor &&
            (!actor || actor.id !== expectedActor.id || actor.accountId !== expectedActor.accountId)
          )
            throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          if (actor) expectedActor ??= actor;
          if (!pointer) missing();
          await lockShared(tx, `album:${pointer.albumId}`);
          const photo = await tx.albumPhoto.findUnique({
            where: { id: idInput(id) },
            select: {
              id: true,
              albumId: true,
              removedAt: true,
              featuredAt: true,
              featuredPool: true,
              featuredSelectedAt: true,
              mime: true,
              originalName: true,
              album: { select: { removedAt: true, publicity: true } }
            }
          });
          if (actor) {
            const fresh = await this.account(tx, token);
            if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
              throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          }
          if (photo && photo.albumId !== pointer.albumId) return retry;
          if (
            !photo ||
            photo.removedAt ||
            photo.album.removedAt ||
            (token == null &&
              (!photo.featuredAt ||
                photo.featuredPool !== 'SELECTED' ||
                !photo.featuredSelectedAt ||
                photo.album.publicity !== 'PUBLIC_FEATURED'))
          )
            missing();
          return {
            actor,
            mime: variant === 'original' ? photo.mime : 'image/webp',
            filename: photo.originalName
          };
        });
        if (result !== retry) return result;
      }
      throw new AccountError('CONFLICT', '图片所属相册已变化，请重试', 409);
    };
    const initial = await authorize();
    let bytes: Buffer;
    try {
      bytes = await this.storage.read(id, variant);
    } catch {
      missing();
    }
    // A second short transaction re-reads the current album, photo and visibility.
    const meta = await authorize(initial.actor ?? undefined);
    return { mime: meta.mime, filename: meta.filename, bytes };
  }

  async like(id: string, body: Body, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.writer(tx, token),
        pointer = await tx.albumPhoto.findUnique({ where: { id: idInput(id) }, select: { albumId: true } });
      if (!pointer) missing();
      const album = await this.album(tx, pointer.albumId, true);
      const photo = await this.photo(tx, album.id, id);
      await this.account(tx, token);
      if (typeof body.liked !== 'boolean') bad('点赞状态无效');
      const key = { photoId: id, accountId: actor.accountId };
      if (body.liked) {
        await tx.albumLike.upsert({ where: { photoId_accountId: key }, create: key, update: {} });
        await emitMessage(tx, {
          recipientId: photo.uploaderId,
          actorId: actor.accountId,
          kind: 'LIKE',
          sourceType: 'album',
          sourceId: photo.id,
          eventKey: `like:album:${photo.id}:${actor.accountId}`,
          createdAt: this.auth.now()
        });
      } else await tx.albumLike.deleteMany({ where: key });
      return { liked: body.liked, likes: await tx.albumLike.count({ where: { photoId: id } }) };
    });
  }
  async comments(id: string, url: URL, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token),
        album = await this.album(tx, id),
        photoId = optionalId(url.searchParams.get('photoId'));
      if (photoId) await this.photo(tx, album.id, photoId);
      // Legacy validation follows the comment read, so a failed read must still
      // win over an invalid page. Retain that error while deriving a safe offset.
      const pagination = (() => {
        try {
          return { page: pageInput(url) };
        } catch (error) {
          return { page: 1, error };
        }
      })();
      const all = url.searchParams.get('all') === '1';
      type Member = Prisma.AccountGetPayload<{ select: typeof memberSelect }>;
      type JsonMember = Omit<Member, 'createdAt'> & { createdAt: number };
      type Row = {
        total: bigint;
        id: string | null;
        body: string;
        authorId: string;
        parentId: string | null;
        createdAt: Date;
        revision: number;
        author: JsonMember;
        replyTo: JsonMember | null;
        media: { id: string; width: number; height: number; frames: number }[];
      };
      // Reachability is scoped exactly like visibleCommentIds: removed ancestors,
      // broken links and rootless cycles never promote descendants to roots.
      // One statement keeps count, page, members and media in one ReadCommitted
      // snapshot. Only the selected page is hydrated; all=1 keeps its existing API.
      const rows = await tx.$queryRaw<Row[]>`
        WITH RECURSIVE scope AS MATERIALIZED (
          SELECT id, "parentId", "createdAt" FROM "AlbumComment"
          WHERE "albumId" = ${album.id}
            AND "photoId" IS NOT DISTINCT FROM ${photoId}
            AND "removedAt" IS NULL
        ), visible AS (
          SELECT id, "parentId", "createdAt" FROM scope WHERE "parentId" IS NULL
          UNION
          SELECT c.id, c."parentId", c."createdAt"
          FROM scope c JOIN visible p ON c."parentId" = p.id
        ), page AS MATERIALIZED (
          SELECT c.* FROM "AlbumComment" c JOIN visible v ON v.id = c.id
          ORDER BY c."createdAt" ASC, c.id ASC
          LIMIT ${all ? null : 10} OFFSET ${all ? 0 : (pagination.page - 1) * 10}
        ), members AS MATERIALIZED (
          SELECT a.id, jsonb_build_object(
            'id', a.id, 'displayName', a."displayName",
            'gameRegion', a."gameRegion", 'gameServer', a."gameServer",
            'membership', a.membership,
            'createdAt', (EXTRACT(EPOCH FROM a."createdAt") * 1000)::bigint,
            'profile', CASE WHEN p."accountId" IS NULL THEN NULL ELSE jsonb_build_object(
              'bio', p.bio, 'commonJobs', p."commonJobs",
              'preferredPlaystyles', p."preferredPlaystyles", 'revision', p.revision,
              'avatar', CASE WHEN av.id IS NULL THEN NULL ELSE jsonb_build_object(
                'id', av.id, 'width', av.width, 'height', av.height
              ) END
            ) END
          ) AS value
          FROM "Account" a
          JOIN (
            SELECT "authorId" AS id FROM page
            UNION
            SELECT parent."authorId" FROM page
            JOIN "AlbumComment" parent ON parent.id = page."parentId"
          ) required ON required.id = a.id
          LEFT JOIN "MemberProfile" p ON p."accountId" = a.id
          LEFT JOIN "AvatarAsset" av ON av.id = p."avatarId"
        )
        SELECT totals.total, c.id, c.body, c."authorId", c."parentId",
          c."createdAt", c.revision, author.value AS author, reply.value AS "replyTo",
          COALESCE(media.items, '[]'::jsonb) AS media
        FROM (SELECT COUNT(*) AS total FROM visible) totals
        LEFT JOIN page c ON TRUE
        LEFT JOIN members author ON author.id = c."authorId"
        LEFT JOIN "AlbumComment" parent ON parent.id = c."parentId"
        LEFT JOIN members reply ON reply.id = parent."authorId"
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'id', m.id, 'width', m.width, 'height', m.height, 'frames', m.frames
          ) ORDER BY m.position ASC, m.id ASC) AS items
          FROM "AlbumCommentMedia" m
          WHERE m."commentId" = c.id AND m."removedAt" IS NULL
        ) media ON TRUE
        ORDER BY c."createdAt" ASC, c.id ASC
      `;
      if ('error' in pagination) throw pagination.error;
      const summary = (member: JsonMember) =>
        memberSummary({ ...member, createdAt: new Date(member.createdAt) });
      return {
        items: rows.flatMap((c) =>
          c.id === null
            ? []
            : [
                {
                  id: c.id,
                  body: c.body,
                  author: summary(c.author),
                  parentId: c.parentId,
                  replyTo: c.replyTo ? summary(c.replyTo) : null,
                  createdAt: c.createdAt.toISOString(),
                  revision: c.revision,
                  removed: false,
                  canDelete: c.authorId === actor.accountId,
                  canModerate: admin(actor.account.adminRole),
                  media: c.media.map((m) => ({
                    id: m.id,
                    width: m.width,
                    height: m.height,
                    frames: m.frames,
                    thumbnailUrl: `/api/albums/${album.id}/comment-media/${m.id}?variant=thumbnail`,
                    previewUrl: `/api/albums/${album.id}/comment-media/${m.id}?variant=preview`
                  }))
                } satisfies CommentView
              ]
        ),
        total: Number(rows[0]!.total)
      };
    });
  }
  async comment(id: string, body: Body, token?: string | null) {
    const content = text(body.body, 2000),
      photoId = optionalId(body.photoId),
      parentId = optionalId(body.parentId),
      submissionKey = idInput(body.submissionKey);
    if (!Array.isArray(body.mentions) || body.mentions.length > 20) bad('提及成员无效');
    const mentions = [...new Set(body.mentions.map(idInput))].sort();
    const values = body.mediaIds ?? [];
    if (!Array.isArray(values) || values.length > ALBUM_RULES.maxBatch) bad('每次最多选择10张图片');
    const mediaIds = values.map(idInput);
    if (new Set(mediaIds).size !== mediaIds.length) bad('图片不能重复');
    if (!content && !mediaIds.length) bad('请填写正文或选择图片');
    return this.command(id, 'comment', body, token, async (tx, album, actor) => {
      const photo = photoId ? await this.photo(tx, album.id, photoId) : null;
      // Preserve idempotency for comments committed before AlbumCommand existed.
      const legacy = await tx.albumComment.findUnique({
        where: { authorId_submissionKey: { authorId: actor.accountId, submissionKey } },
        include: { media: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } }
      });
      if (legacy) {
        if (
          legacy.albumId !== album.id ||
          legacy.body !== content ||
          legacy.photoId !== photoId ||
          legacy.parentId !== parentId ||
          JSON.stringify(legacy.mentions) !== JSON.stringify(mentions) ||
          JSON.stringify(legacy.media.map((m) => m.id)) !== JSON.stringify(mediaIds)
        )
          conflict();
        return { id: legacy.id };
      }
      const parent = parentId
        ? await tx.albumComment.findFirst({
            where: { id: parentId, albumId: album.id, photoId, removedAt: null },
            select: { authorId: true }
          })
        : null;
      const ancestry = await tx.albumComment.findMany({
        where: { albumId: album.id, photoId },
        select: { id: true, parentId: true, removedAt: true }
      });
      if (parentId && (!parent || !visibleCommentIds(ancestry).has(parentId))) bad('回复目标不存在或已删除');
      const people = await tx.account.findMany({
        where: { id: { in: mentions } },
        select: { ...person, gameServer: true }
      });
      const sameNames = mentions.length
        ? await tx.account.findMany({
            where: { displayName: { in: people.flatMap((p) => (p.displayName ? [p.displayName] : [])) } },
            select: person
          })
        : [];
      if (
        people.length !== mentions.length ||
        people.some(
          (p) =>
            !p.displayName ||
            !containsMention(
              content,
              mentionText(p, sameNames.filter((other) => other.displayName === p.displayName).length > 1)
            )
        )
      )
        bad('提及成员与正文不一致');
      const media = await tx.albumCommentMedia.findMany({ where: { id: { in: mediaIds } } });
      if (
        media.length !== mediaIds.length ||
        media.some(
          (m) => m.ownerId !== actor.accountId || m.albumId !== album.id || m.removedAt || m.commentId
        )
      )
        denied('部分图片不可用于此评论');
      if (
        mediaIds.length &&
        (await (await import('@artzoo/db')).albumCommentMediaFencedTx(tx, actor.accountId, mediaIds))
      )
        denied('部分图片不可用于此评论');
      const comment = await tx.albumComment.create({
        data: {
          albumId: album.id,
          photoId,
          parentId,
          authorId: actor.accountId,
          body: content,
          mentions,
          submissionKey
        }
      });
      for (let position = 0; position < mediaIds.length; position++)
        await tx.albumCommentMedia.update({
          where: { id: mediaIds[position] },
          data: { commentId: comment.id, position }
        });
      const recipients = new Set([
        photo?.uploaderId ?? album.creatorId,
        ...(parent ? [parent.authorId] : []),
        ...mentions
      ]);
      recipients.delete(actor.accountId);
      await tx.albumNotification.createMany({
        data: [...recipients].map((recipientId) => ({
          recipientId,
          commentId: comment.id,
          albumId: album.id,
          photoId,
          kind: 'ALBUM_INTERACTION'
        }))
      });
      return { id: comment.id };
    });
  }
  async removeComment(id: string, body: Body, token?: string | null) {
    id = idInput(id);
    const pointer = await this.auth.transaction(async (tx) => {
      await this.account(tx, token);
      const row = await tx.albumComment.findUnique({ where: { id }, select: { albumId: true } });
      if (!row) missing();
      return row;
    });
    const expected = revision(body.revision);
    return this.command(pointer.albumId, `remove-comment:${id}`, body, token, async (tx, album, actor) => {
      const c = await tx.albumComment.findUnique({ where: { id } });
      if (!c || c.albumId !== album.id || c.removedAt) missing();
      if (c.authorId !== actor.accountId && !admin(actor.account.adminRole)) denied();
      if (c.revision !== expected) conflict();
      const { reason } = deletionIntent(
        body,
        c.authorId === actor.accountId,
        admin(actor.account.adminRole),
        '作者删除本人评论',
        500,
        c.authorId !== actor.accountId
      );
      const rows = await tx.albumComment.findMany({
        where: { albumId: album.id, photoId: c.photoId },
        select: { id: true, parentId: true, removedAt: true }
      });
      if (!visibleCommentIds(rows).has(c.id)) missing();
      const branch = [...commentSubtreeIds(rows, c.id)];
      await tx.albumComment.updateMany({
        where: { albumId: album.id, id: { in: branch }, removedAt: null },
        data: { removedAt: this.auth.now(), revision: { increment: 1 } }
      });
      await tx.albumAudit.create({
        data: {
          albumId: album.id,
          photoId: c.photoId,
          actorId: actor.accountId,
          action: 'COMMENT_REMOVED',
          reason
        }
      });
      return { id: c.id, removed: true };
    });
  }
  async uploadCommentMedia(id: string, body: Body, input: Buffer, name: string, token?: string | null) {
    const fields = uploadFields(body),
      albumId = idInput(id);
    if (fields.periodActivityId) bad('评论图片不接受期次');
    if (!input.length || input.length > ALBUM_RULES.maxBytes) bad('每张图片最多30MiB');
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.transaction(async (tx) => {
      await this.account(tx, token);
      await this.album(tx, albumId);
    });
    const fingerprint = createHash('sha256')
      .update(albumId)
      .update('\0')
      .update(name)
      .update('\0')
      .update(input)
      .digest('hex');
    const inspect = async (tx: Tx) => {
      const fresh = await this.writer(tx, token);
      if (fresh.accountId !== actor.accountId) denied();
      await lock(tx, `album-comment-upload:${fresh.accountId}:${fields.batchId}:${fields.batchIndex}`);
      await this.album(tx, albumId, true);
      const old = await tx.albumCommentMedia.findUnique({
        where: {
          ownerId_batchId_batchIndex: {
            ownerId: fresh.accountId,
            batchId: fields.batchId,
            batchIndex: fields.batchIndex
          }
        }
      });
      if (old && (old.fingerprint !== fingerprint || old.removedAt)) conflict();
      if (
        old &&
        (await (await import('@artzoo/db')).albumCommentMediaFencedTx(tx, fresh.accountId, [old.id]))
      )
        conflict();
      await this.account(tx, token);
      return { fresh, old };
    };
    const replay = await this.auth.transaction(async (tx) => {
      const { old } = await inspect(tx);
      return old ? { id: old.id, replayed: true } : null;
    });
    if (replay) return replay;
    const policy =
      (process.env.ARTZOO_MEDIA_BUDGET_ENABLED ?? '0') === '0' ? null : mediaBudgetPolicy(process.env);
    let attempt: MediaBudgetAttempt | undefined;
    let boundAllocation: MediaBoundAllocationTicket | undefined;
    let namespaces: Awaited<ReturnType<NonNullable<PhotoStorage['writePhotoNamespaces']>>> | undefined;
    const photoWrites: import('@artzoo/media/stock-retirement').MediaWriteProof[] = [];
    const retainUnknown = async () => {
      try {
        await attempt?.unknown();
      } catch {
        console.warn('Album comment budget outcome remains uncertain');
      }
    };
    let budgetMediaId: string | undefined, output: Awaited<ReturnType<typeof processPhoto>>;
    if (policy?.enabled) {
      budgetMediaId = randomUUID();
      try {
        const prepared = await (
          await import('@artzoo/db')
        )
          .createMediaBudgetAdapter(this.auth.db, policy, this.auth.now)
          .prepare({
            scope: 'album-comment',
            operationKey: `${actor.accountId}:${fields.batchId}:${fields.batchIndex}`,
            fingerprint,
            accountId: actor.accountId,
            rawBytes: BigInt(input.length),
            objectIdentity: `album-comment:${budgetMediaId}`
          });
        if (prepared.kind !== 'owner') {
          const current = await this.auth.transaction((tx) => inspect(tx));
          if (current.old) return { id: current.old.id, replayed: true };
          throw mediaUploadPendingError();
        }
        attempt = prepared.attempt;
      } catch (error) {
        throw mediaBudgetError(error);
      }
    }
    try {
      output = await withPhotoSlot(() => processPhoto(input, name));
      if (attempt) {
        if (this.commentStorage.writePhotoNamespaces || this.commentStorage.boundPhotoNamespaces) {
          namespaces = await (this.commentStorage.writePhotoNamespaces ??
            this.commentStorage.boundPhotoNamespaces)!.call(this.commentStorage, 'album-comment');
          boundAllocation = await attempt.allocateBoundComponents({
            kind: 'photo',
            scope: 'album-comment',
            originalBytes: BigInt(output.original.length),
            previewBytes: BigInt(output.preview.length),
            thumbnailBytes: BigInt(output.thumbnail.length),
            contentHashes: {
              original: createHash('sha256').update(output.original).digest('hex'),
              preview: createHash('sha256').update(output.preview).digest('hex'),
              thumbnail: createHash('sha256').update(output.thumbnail).digest('hex')
            }
          });
        } else
          await attempt.allocate(
            BigInt(output.original.length) + BigInt(output.preview.length) + BigInt(output.thumbnail.length)
          );
      }
    } catch (error) {
      if (!attempt) throw error;
      try {
        await attempt.failBeforePersistence();
      } catch {
        console.warn('Album comment prewrite budget cleanup deferred');
      }
      throw mediaBudgetError(error);
    }
    const mediaId = budgetMediaId ?? randomUUID();
    if (attempt) {
      try {
        await attempt.begin();
      } catch (error) {
        await retainUnknown();
        throw mediaBudgetError(error);
      }
    }
    try {
      await this.commentStorage.put(mediaId, output);
      if (namespaces)
        for (const variant of ['original', 'preview', 'thumbnail'] as const)
          photoWrites.push(
            await namespaces[variant === 'original' ? 'original' : 'derived'].capture(
              mediaId,
              ('photo-' + variant) as 'photo-original' | 'photo-preview' | 'photo-thumbnail',
              createHash('sha256').update(output[variant]).digest('hex'),
              BigInt(output[variant].length)
            )
          );
    } catch (error) {
      if (!attempt) throw error;
      await retainUnknown();
      throw mediaBudgetError(error);
    }
    try {
      return await this.auth
        .transaction(async (tx) => {
          const { fresh, old } = await inspect(tx);
          if (old) return { id: old.id, replayed: true };
          await tx.albumCommentMedia.create({
            data: {
              id: mediaId,
              ownerId: fresh.accountId,
              albumId,
              batchId: fields.batchId,
              batchIndex: fields.batchIndex,
              fingerprint,
              mime: output.mime,
              width: output.width,
              height: output.height,
              frames: output.frames
            }
          });
          await this.account(tx, token);
          if (attempt) {
            await attempt.commit(tx);
            if (boundAllocation)
              await (
                await import('@artzoo/media/stock-retirement')
              ).bindAlbumCommentPhotoWrite(tx, boundAllocation, fresh.accountId, mediaId, photoWrites);
            const settled = await this.account(tx, token);
            if (
              settled.id !== fresh.id ||
              settled.accountId !== fresh.accountId ||
              this.auth.now() >= settled.expiresAt
            )
              throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          }
          return { id: mediaId, replayed: false };
        })
        .then(async (result) => {
          if (result.replayed) {
            await this.commentStorage.discardUncommitted(mediaId).catch(() => undefined);
            if (attempt) await retainUnknown();
          }
          return result;
        });
    } catch (error) {
      if (attempt) await retainUnknown();
      // A null confirmation SELECT cannot prove that an uncertain COMMIT will not finish later.
      if (!policy?.enabled) {
        try {
          if (
            !(await this.auth.db.albumCommentMedia.findUnique({
              where: { id: mediaId },
              select: { id: true }
            }))
          )
            await this.commentStorage.discardUncommitted(mediaId);
        } catch {
          console.warn('Uncommitted comment media cleanup deferred');
        }
      }
      throw attempt ? mediaBudgetError(error) : error;
    }
  }
  async commentMedia(id: string, mediaId: string, variant: PhotoVariant, token?: string | null) {
    if (!['original', 'preview', 'thumbnail'].includes(variant)) bad('图片版本无效');
    const authorize = (expected?: { id: string; accountId: string }) =>
      this.auth.transaction(async (tx) => {
        const actor = await this.account(tx, token);
        if (expected && (actor.id !== expected.id || actor.accountId !== expected.accountId))
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        await lockShared(tx, `album:${idInput(id)}`);
        const album = await this.album(tx, id);
        const media = await tx.albumCommentMedia.findFirst({
          where: { id: idInput(mediaId), albumId: album.id, removedAt: null },
          include: { comment: true }
        });
        if (!media || (!media.commentId && media.ownerId !== actor.accountId)) missing();
        if (await (await import('@artzoo/db')).albumCommentMediaFencedTx(tx, media.ownerId, [media.id]))
          missing();
        if (media.comment) {
          if (media.comment.photoId) await this.photo(tx, album.id, media.comment.photoId);
          const ancestry = await tx.albumComment.findMany({
            where: { albumId: album.id, photoId: media.comment.photoId },
            select: { id: true, parentId: true, removedAt: true }
          });
          if (!visibleCommentIds(ancestry).has(media.comment.id)) missing();
        }
        const fresh = await this.account(tx, token);
        if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        return { actor, mediaId: media.id, mime: variant === 'original' ? media.mime : 'image/webp' };
      });
    const initial = await authorize();
    // Release the album lock before reading; recheck its current attachment after.
    const bytes = await this.commentStorage.read(initial.mediaId, variant);
    const current = await authorize(initial.actor);
    return { bytes, mime: current.mime };
  }

  async featured(url: URL, token?: string | null, management = false) {
    return this.auth.db.$transaction(
      async (tx) => {
        let role = 'NONE';
        if (token != null || management) role = (await this.account(tx, token)).account.adminRole;
        if (management && !admin(role)) denied();
        const page = pageInput(url),
          pool = management ? featuredPoolInput(url.searchParams.get('pool') ?? 'CANDIDATE') : 'SELECTED';
        const query = text(url.searchParams.get('query') ?? '', 100);
        const where = {
          ...(management && query
            ? {
                OR: [
                  { description: { contains: query, mode: 'insensitive' as const } },
                  { originalName: { contains: query, mode: 'insensitive' as const } },
                  { uploader: { displayName: { contains: query, mode: 'insensitive' as const } } }
                ]
              }
            : {}),
          removedAt: null,
          featuredAt: { not: null },
          featuredPool: pool,
          ...(!management ? { featuredSelectedAt: { not: null } } : {}),
          album: { removedAt: null, ...(!management ? { publicity: 'PUBLIC_FEATURED' as const } : {}) }
        };
        const [rows, total] = await Promise.all([
          tx.albumPhoto.findMany({
            where,
            select: {
              id: true,
              albumId: true,
              description: true,
              width: true,
              height: true,
              rotation: true,
              revision: true,
              featuredAt: true,
              featuredPool: true,
              featuredSelectedAt: true,
              ...(management
                ? {
                    originalName: true,
                    createdAt: true,
                    album: { select: { name: true, publicity: true } },
                    uploader: { select: person }
                  }
                : {})
            },
            orderBy:
              pool === 'SELECTED'
                ? [{ featuredSelectedAt: 'desc' }, { id: 'desc' }]
                : [{ featuredAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * 24,
            take: 25
          }),
          tx.albumPhoto.count({ where })
        ]);
        return {
          items: rows.slice(0, 24).map((p) => {
            const { album, ...photo } = p;
            return {
              ...photo,
              ...(album
                ? { album: { name: album.name, visibility: visibilityFromPublicity(album.publicity) } }
                : {}),
              previewUrl: '/api/album-photos/' + p.id + '/media?variant=preview',
              thumbnailUrl: '/api/album-photos/' + p.id + '/media?variant=thumbnail'
            };
          }),
          hasMore: rows.length > 24,
          page,
          total,
          totalPages: Math.max(1, Math.ceil(total / 24))
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  async audits(id: string, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token);
      if (!admin(actor.account.adminRole)) denied();
      return {
        items: await tx.albumAudit.findMany({
          where: { photoId: idInput(id) },
          include: { actor: { select: person } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100
        })
      };
    });
  }
  // Separate IN_APP-only source for the central message owner to merge; never writes QQ outbox.
  async memberPhotos(id: string, url: URL, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token),
        uploaderId = idInput(id);
      if (!(await tx.account.findUnique({ where: { id: uploaderId }, select: { id: true } }))) missing();
      const rows = await tx.albumPhoto.findMany({
        where: { uploaderId, removedAt: null, album: { removedAt: null } },
        include: { ...photoInclude, album: { select: { creatorId: true, publicity: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 7,
        skip: (pageInput(url) - 1) * 6
      });
      const visible = rows.slice(0, 6),
        likedIds = await this.likedPhotoIds(tx, visible, actor.accountId);
      return {
        items: await Promise.all(
          visible.map((row) =>
            this.photoView(
              tx,
              row,
              actor.accountId,
              actor.account.adminRole,
              row.album.creatorId,
              row.album.publicity,
              likedIds.has(row.id)
            )
          )
        ),
        hasMore: rows.length > 6
      };
    });
  }
  async photoDetail(id: string, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token),
        row = await tx.albumPhoto.findUnique({ where: { id: idInput(id) }, select: { albumId: true } });
      if (!row) missing();
      const album = await this.album(tx, row.albumId),
        photo = await this.photo(tx, album.id, id);
      return this.photoView(
        tx,
        photo,
        actor.accountId,
        actor.account.adminRole,
        album.creatorId,
        album.publicity
      );
    });
  }
  async notifications(token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.account(tx, token);
      return {
        items: await tx.albumNotification.findMany({
          where: { recipientId: actor.accountId, messageDeletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100
        })
      };
    });
  }
}
