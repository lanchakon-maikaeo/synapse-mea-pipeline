import assert from "node:assert/strict";
import test from "node:test";

import { validateProductionSupabaseConfiguration } from "../scripts/verify-production-config.mjs";

const canonicalUrl = "https://fvdfduuanfrncrwuareb.supabase.co";

test("production configuration guard does not constrain local or preview builds", () => {
  assert.deepEqual(validateProductionSupabaseConfiguration({}), {
    ok: true,
    skipped: true,
  });
  assert.deepEqual(validateProductionSupabaseConfiguration({ VERCEL_ENV: "preview" }), {
    ok: true,
    skipped: true,
  });
  assert.deepEqual(
    validateProductionSupabaseConfiguration({
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "mea-synapse-staging.vercel.app",
    }),
    { ok: true, skipped: true },
  );
});

test("production configuration guard accepts the approved Supabase origin and a publishable key", () => {
  assert.deepEqual(
    validateProductionSupabaseConfiguration({
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "mea-synapse-web.vercel.app",
      NEXT_PUBLIC_SUPABASE_URL: canonicalUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_example",
    }),
    { ok: true, skipped: false, errors: [] },
  );
});

test("production configuration guard rejects a legacy project or a missing key", () => {
  const result = validateProductionSupabaseConfiguration({
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "mea-synapse-web.vercel.app",
    NEXT_PUBLIC_SUPABASE_URL: "https://jbwbmrizawxcrtliozqt.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder",
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /fvdfduuanfrncrwuareb/);
  assert.match(result.errors[1], /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});

test("production configuration guard rejects local demo mode", () => {
  const result = validateProductionSupabaseConfiguration({
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "mea-synapse-web.vercel.app",
    NEXT_PUBLIC_SUPABASE_URL: canonicalUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_example",
    NEXT_PUBLIC_SYNAPSE_DEMO_MODE: "true",
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.errors, [
    "NEXT_PUBLIC_SYNAPSE_DEMO_MODE must not be enabled for the production deployment.",
  ]);
});
