import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/storage/postgres/schema.ts",
  out: "./drizzle/postgres",
  migrations: {
    schema:
      process.env.INSTAGRAM_SAVES_PG_SCHEMA?.trim() || "instagram_saves",
  },
});
