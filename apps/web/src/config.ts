// Site-wide constants for the Gesso marketing + onboarding site.

// Base URL of the provisioning Worker (workers/provision). The onboarding flow
// in /start points its OAuth + provision buttons here. Override per environment
// by editing this value (or wire it to an env var at build time).
//
// Local dev:        http://127.0.0.1:8787
// Production:       https://provision.usegesso.com (example custom route)
export const PROVISION_BASE =
  import.meta.env.PUBLIC_PROVISION_BASE ?? 'https://provision.usegesso.com';

// Worker route helpers — these endpoints are implemented in workers/provision.
export const ROUTES = {
  authGithub: `${PROVISION_BASE}/auth/github`,
  authNetlify: `${PROVISION_BASE}/auth/netlify`,
  provision: `${PROVISION_BASE}/provision`,
  session: `${PROVISION_BASE}/session`,
};
