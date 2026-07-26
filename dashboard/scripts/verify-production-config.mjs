#!/usr/bin/env node

const CANONICAL_PRODUCTION_SUPABASE_REF = "fvdfduuanfrncrwuareb";
const CANONICAL_PRODUCTION_SUPABASE_ORIGIN = `https://${CANONICAL_PRODUCTION_SUPABASE_REF}.supabase.co`;

function isSupabasePublishableKey(value) {
  return (
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(value) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

export function validateProductionSupabaseConfiguration(env = process.env) {
  if (env.VERCEL_ENV !== "production") {
    return { ok: true, skipped: true };
  }

  const errors = [];
  if (env.NEXT_PUBLIC_SUPABASE_URL !== CANONICAL_PRODUCTION_SUPABASE_ORIGIN) {
    errors.push(
      `NEXT_PUBLIC_SUPABASE_URL must be ${CANONICAL_PRODUCTION_SUPABASE_ORIGIN} for the production deployment.`,
    );
  }

  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!key || !isSupabasePublishableKey(key)) {
    errors.push(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY must contain a valid publishable key for the production Supabase project.",
    );
  }

  return { ok: errors.length === 0, skipped: false, errors };
}

const result = validateProductionSupabaseConfiguration();
if (!result.ok) {
  console.error("Production Supabase configuration validation failed:");
  for (const message of result.errors) console.error(`- ${message}`);
  process.exitCode = 1;
}
