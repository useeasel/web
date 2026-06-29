// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Gesso marketing + onboarding site. Static output, deployed to Cloudflare Pages
// at usegesso.com. The interactive onboarding (`/start`) talks to the
// provisioning Worker over fetch — see PUBLIC_PROVISION_BASE in src/config.ts.
export default defineConfig({
  site: 'https://usegesso.com',
  output: 'static',
  integrations: [
    sitemap({
      // `/start/done` is a transient per-artist confirmation page (only meaningful
      // mid-flow with a job in the URL) — keep it out of the public sitemap.
      filter: (page) => !page.startsWith('https://usegesso.com/start/done'),
    }),
  ],
});
