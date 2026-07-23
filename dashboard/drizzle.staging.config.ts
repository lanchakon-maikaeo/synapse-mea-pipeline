import { defineConfig } from "drizzle-kit";

const url = process.env.STAGING_DATABASE_URL;
const confirmation = process.env.STAGING_DB_CONFIRM;

if (!url) {
  throw new Error("STAGING_DATABASE_URL is required; Production URLs are not accepted by this config.");
}

if (confirmation !== "MEA_SYNAPSE_STAGING") {
  throw new Error("Set STAGING_DB_CONFIRM=MEA_SYNAPSE_STAGING before applying Staging migrations.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
