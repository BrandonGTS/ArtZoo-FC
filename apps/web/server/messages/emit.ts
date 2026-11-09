import { randomUUID } from 'node:crypto';
import { Prisma } from '@artzoo/db';
export interface MessageEmission {
  recipientId: string;
  actorId: string | null;
  kind: 'COMMENT' | 'LIKE' | 'COLLECTION' | 'WISH_INTEREST' | 'REGISTRATION_CREATED';
  sourceType: 'activity' | 'daily' | 'album' | 'knowledge' | 'wish';
  sourceId: string;
  commentId?: string | null;
  /** Stable logical event key: a like uses source + actor, never a toggle/request key. */
  eventKey: string;
  createdAt: Date;
}
/** Called inside the successful source command transaction. No delivery or historical backfill. */
export async function emitMessage(tx: Prisma.TransactionClient, input: MessageEmission) {
  if (input.actorId === input.recipientId) return;
  await tx.$executeRaw`INSERT INTO "MessageNotification" (id,"recipientId","actorId",kind,"sourceType","sourceId","commentId","eventKey","createdAt")
 VALUES (${randomUUID()},${input.recipientId},${input.actorId},${input.kind},${input.sourceType},${input.sourceId},${input.commentId ?? null},${input.eventKey},${input.createdAt})
 ON CONFLICT ("eventKey") DO NOTHING`;
}
