/**
 * URL constants and environment-aware getters.
 */

const DevWebAppURL = "http://localhost:3001";
const ProdWebAppURL = "https://app.dosu.dev";

const DevBackendURL = "http://localhost:7001";
const ProdBackendURL = "https://api.dosu.dev";

const DevSupabaseURL = "http://localhost:54321";
const ProdSupabaseURL = "https://wldmetsoicvieidlsqrb.supabase.co";

// Supabase anon keys — public, safe to embed in client code
const DevSupabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ProdSupabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsbG1ldHNvaWN2aWVpZGxzcXJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQ0NjA1NjUsImV4cCI6MjA1MDAzNjU2NX0.15LIxqSMVRnxsvLrk0GPjL1aSYPfOeaeFMdJXqgc5Xs";

function isDev(): boolean {
  return process.env.DOSU_DEV === "true";
}

export function getWebAppURL(): string {
  if (process.env.DOSU_WEB_APP_URL) return process.env.DOSU_WEB_APP_URL;
  return isDev() ? DevWebAppURL : ProdWebAppURL;
}

export function getBackendURL(): string {
  if (process.env.DOSU_BACKEND_URL) return process.env.DOSU_BACKEND_URL;
  return isDev() ? DevBackendURL : ProdBackendURL;
}

export function getSupabaseURL(): string {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL;
  return isDev() ? DevSupabaseURL : ProdSupabaseURL;
}

export function getSupabaseAnonKey(): string {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY;
  return isDev() ? DevSupabaseAnonKey : ProdSupabaseAnonKey;
}
