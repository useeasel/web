// @ts-check
import { defineConfig } from 'astro/config';

// Easel marketing + onboarding site. Static output, deployed to Cloudflare Pages
// at easel.rosematcha.com. The interactive onboarding (`/start`) talks to the
// provisioning Worker over fetch — see PUBLIC_PROVISION_BASE in src/config.ts.
export default defineConfig({
  site: 'https://easel.rosematcha.com',
  output: 'static',
});
