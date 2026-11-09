// One in-memory success handoff across client navigation, scoped to its creator and team.
// Business success never depends on browser storage availability.
let created: { creatorId: string; teamId: string; at: number } | null = null;
export function rememberCreatedTeam(creatorId: string, teamId: string) {
  created = { creatorId, teamId, at: Date.now() };
}
export function consumeCreatedTeam(creatorId: string, teamId: string): boolean {
  if (!created) return false;
  const age = Date.now() - created.at;
  if (age < 0 || age >= 30000) {
    created = null;
    return false;
  }
  if (created.creatorId !== creatorId || created.teamId !== teamId) return false;
  created = null;
  return true;
}
