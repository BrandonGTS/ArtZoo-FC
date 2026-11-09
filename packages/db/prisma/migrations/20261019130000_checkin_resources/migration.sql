CREATE TABLE "DailyCheckin" (
 "id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "day" VARCHAR(10) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DailyCheckin_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DailyCheckin_day_check" CHECK ("day" ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' AND to_char(to_date("day", 'YYYY-MM-DD'), 'YYYY-MM-DD') = "day")
);
CREATE UNIQUE INDEX "DailyCheckin_accountId_day_key" ON "DailyCheckin"("accountId", "day");
CREATE TABLE "ResourceCategory" (
 "id" TEXT PRIMARY KEY, "name" VARCHAR(40) NOT NULL, "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE UNIQUE INDEX "ResourceCategory_name_key" ON "ResourceCategory"("name");
CREATE TABLE "ResourceLink" (
 "id" TEXT PRIMARY KEY, "name" VARCHAR(80) NOT NULL, "purpose" VARCHAR(200) NOT NULL, "url" VARCHAR(2048) NOT NULL,
 "categoryId" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "ResourceLink_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ResourceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ResourceLink_categoryId_name_id_idx" ON "ResourceLink"("categoryId", "name", "id");
