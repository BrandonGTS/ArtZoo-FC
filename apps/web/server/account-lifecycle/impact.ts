import type { Prisma } from '@artzoo/db';
import type { LifecycleImpact } from '@artzoo/domain';
import { tokenDigest } from '../auth/crypto';
type Tx = Prisma.TransactionClient;
export const emptyImpact = (): LifecycleImpact => ({
  activities: [],
  registrations: [],
  dissolvedTeams: [],
  memberships: [],
  sessions: [],
  sessionMembers: [],
  substitutes: [],
  applications: [],
  sessionsRevoked: 0
});
export async function collectImpact(tx: Tx, targetId: string, active: boolean, now: Date) {
  const activities = active
    ? []
    : await tx.activity.findMany({
        where: {
          endsAt: { gt: now },
          OR: [
            { organizerId: targetId, cancelledAt: null },
            { registrations: { some: { accountId: targetId, status: 'ACTIVE' } } }
          ]
        },
        orderBy: { id: 'asc' },
        include: {
          registrations: { where: { status: 'ACTIVE' }, orderBy: { id: 'asc' }, include: { seat: true } },
          series: true
        }
      });
  const teams = active
    ? []
    : await tx.fixedTeam.findMany({
        where: {
          OR: [
            { creatorId: targetId, state: 'ACTIVE' },
            { state: 'ACTIVE', memberships: { some: { accountId: targetId, state: 'ACTIVE' } } },
            {
              sessions: {
                some: {
                  state: { not: 'CANCELLED' },
                  startsAt: { gt: now },
                  substitutes: { some: { accountId: targetId, endedAt: null } }
                }
              }
            },
            {
              creatorId: { not: targetId },
              applications: { some: { accountId: targetId, state: 'PENDING' } }
            }
          ]
        },
        orderBy: { id: 'asc' },
        include: {
          memberships: { where: { state: 'ACTIVE' }, orderBy: { id: 'asc' } },
          applications: { where: { accountId: targetId, state: 'PENDING' }, orderBy: { id: 'asc' } },
          sessions: {
            orderBy: { id: 'asc' },
            include: {
              members: { orderBy: { id: 'asc' } },
              substitutes: { where: { endedAt: null }, orderBy: { id: 'asc' } }
            }
          }
        }
      });
  const sessions = active
    ? []
    : await tx.accountSession.findMany({
        where: { accountId: targetId, revokedAt: null },
        orderBy: { id: 'asc' },
        select: { id: true, expiresAt: true }
      });
  const cancelled = activities.filter((a) => a.organizerId === targetId && !a.cancelledAt);
  const cancelledIds = new Set(cancelled.map((a) => a.id));
  const registrations = activities.flatMap((a) =>
    a.registrations
      .filter((reg) => cancelledIds.has(a.id) || reg.accountId === targetId)
      .map((reg) => ({ activity: a, registration: reg }))
  );
  const dissolved = teams.filter((team) => team.creatorId === targetId && team.state === 'ACTIVE');
  const dissolvedIds = new Set(dissolved.map((t) => t.id));
  const memberships = teams.flatMap((team) =>
    team.creatorId !== targetId && team.state === 'ACTIVE'
      ? team.memberships.filter((m) => m.accountId === targetId).map((membership) => ({ team, membership }))
      : []
  );
  const cancelledSessions = dissolved.flatMap((team) =>
    team.sessions
      .filter((s) => s.startsAt > now && s.state !== 'CANCELLED')
      .map((session) => ({ team, session }))
  );
  const substitutes = teams.flatMap((team) =>
    team.creatorId !== targetId
      ? team.sessions
          .filter((s) => s.startsAt > now && s.state !== 'CANCELLED')
          .flatMap((session) =>
            session.substitutes
              .filter((s) => s.accountId === targetId && s.timeVersion === session.timeVersion)
              .map((substitute) => ({ team, session, substitute }))
          )
      : []
  );
  const applications = teams.flatMap((team) =>
    team.creatorId !== targetId ? team.applications.map((application) => ({ team, application })) : []
  );
  const sessionMembers = memberships.flatMap(({ team, membership }) =>
    team.sessions
      .filter((s) => s.startsAt > now && s.state === 'CONFIRMED')
      .flatMap((session) =>
        session.members
          .filter(
            (m) =>
              m.membershipId === membership.id &&
              m.timeVersion === session.timeVersion &&
              m.state === 'MEMBER'
          )
          .map((member) => ({ team, session, member }))
      )
  );
  const impact: LifecycleImpact = {
    activities: cancelled.map((a) => ({
      id: a.id,
      title: a.title,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      registrationCount: a.registrations.length
    })),
    registrations: registrations.map(({ activity: a, registration: reg }) => ({
      id: reg.id,
      activityId: a.id,
      title: a.title,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString()
    })),
    dissolvedTeams: dissolved.map((t) => ({ id: t.id, name: t.name })),
    memberships: memberships.map(({ team, membership: m }) => ({
      id: m.id,
      teamId: team.id,
      teamName: team.name
    })),
    sessions: cancelledSessions.map(({ team, session: s }) => ({
      id: s.id,
      teamId: team.id,
      teamName: team.name,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString()
    })),
    sessionMembers: sessionMembers.map(({ team, session, member }) => ({
      id: member.id,
      sessionId: session.id,
      teamId: team.id,
      teamName: team.name,
      timeVersion: member.timeVersion,
      startsAt: session.startsAt.toISOString(),
      endsAt: session.endsAt.toISOString(),
      beforeState: member.state,
      afterState: 'NEEDS_SUBSTITUTE'
    })),
    substitutes: substitutes.map(({ team, session, substitute: s }) => ({
      id: s.id,
      teamId: team.id,
      teamName: team.name,
      startsAt: session.startsAt.toISOString(),
      endsAt: session.endsAt.toISOString()
    })),
    applications: applications.map(({ team, application: a }) => ({
      id: a.id,
      teamId: team.id,
      teamName: team.name
    })),
    sessionsRevoked: sessions.length
  };
  // The complete affected state, not only counts. An unrelated roster/revision change also requires confirmation again.
  const vector = {
    activities: activities.map((a) => ({
      id: a.id,
      revision: a.revision,
      organizerId: a.organizerId,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      cancelledAt: a.cancelledAt,
      series: a.series,
      registrations: a.registrations
    })),
    teams: teams.map((t) => ({
      id: t.id,
      creatorId: t.creatorId,
      state: t.state,
      revision: t.revision,
      memberships: t.memberships,
      applications: t.applications,
      sessions: t.sessions
    })),
    sessions
  };
  const boundaries = [
    ...activities.map((a) => a.endsAt),
    ...cancelledSessions.map((x) => x.session.startsAt),
    ...substitutes.map((x) => x.session.startsAt),
    ...sessionMembers.map((x) => x.session.startsAt)
  ];
  return {
    activities,
    teams,
    registrations,
    cancelled,
    cancelledSessions,
    dissolved,
    memberships,
    substitutes,
    applications,
    sessionMembers,
    sessions,
    impact,
    vector,
    boundary: boundaries.length ? Math.min(...boundaries.map((d) => d.getTime())) : null,
    dissolvedIds
  };
}
export function impactFingerprint(
  target: {
    id: string;
    active: boolean;
    lifecycleRevision: number;
    membership: string;
    adminRole: string;
    adminRoleRevision: number;
  },
  active: boolean,
  vector: unknown
) {
  return tokenDigest(JSON.stringify({ target, active, vector }));
}
export type CollectedImpact = Awaited<ReturnType<typeof collectImpact>>;
