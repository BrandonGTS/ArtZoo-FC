-- Fixed-team post-session corrections are append-only and never touch ordinary activity points.
CREATE TABLE "TeamParticipationChange" (
 "id" TEXT NOT NULL PRIMARY KEY, "teamId" TEXT NOT NULL,
 "memberId" TEXT, "substituteId" TEXT, "status" TEXT NOT NULL, "reason" TEXT NOT NULL,
 "actorId" TEXT NOT NULL, "recordedAt" TIMESTAMPTZ(3) NOT NULL, "revision" INTEGER NOT NULL,
 CONSTRAINT "TeamParticipationChange_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "FixedTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamParticipationChange_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "TeamSessionMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamParticipationChange_substituteId_fkey" FOREIGN KEY ("substituteId") REFERENCES "TeamSessionSubstitute"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamParticipationChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamParticipationChange_target_check" CHECK (("memberId" IS NOT NULL)::int+("substituteId" IS NOT NULL)::int=1),
 CONSTRAINT "TeamParticipationChange_status_check" CHECK ("status" IN ('PRESENT','LEAVE','ABSENT') AND "revision">0),
 CONSTRAINT "TeamParticipationChange_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX "TeamParticipationChange_teamId_revision_key" ON "TeamParticipationChange"("teamId","revision");
CREATE INDEX "TeamParticipationChange_memberId_revision_idx" ON "TeamParticipationChange"("memberId","revision");
CREATE INDEX "TeamParticipationChange_substituteId_revision_idx" ON "TeamParticipationChange"("substituteId","revision");
