#!/usr/bin/env node

const CANONICAL_PRODUCTION_SUPABASE_REF = "fvdfduuanfrncrwuareb";
const CANONICAL_PRODUCTION_SUPABASE_ORIGIN = `https://${CANONICAL_PRODUCTION_SUPABASE_REF}.supabase.co`;
const PRODUCTION_VERCEL_HOST = "mea-synapse-production.vercel.app";

function isSupabasePublishableKey(value) {
  return (
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(value) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

function isProductionTarget(env) {
  return (
    env.SYNAPSE_ENFORCE_PRODUCTION_SUPABASE_TARGET === "true" ||
    (env.VERCEL_ENV === "production" &&
      env.VERCEL_PROJECT_PRODUCTION_URL === PRODUCTION_VERCEL_HOST)
  );
}

export function validateProductionSupabaseConfiguration(env = process.env) {
  if (!isProductionTarget(env)) {
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
