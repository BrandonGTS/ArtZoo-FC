import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Client generation has no database connection or credential requirement.
  datasource: { url: process.env.DATABASE_URL ?? '' }
});
