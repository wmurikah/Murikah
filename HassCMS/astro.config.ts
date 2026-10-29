import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  site: 'https://cms.murikah.com',
  adapter: cloudflare({ imageService: 'compile' }),
  session: { driver: 'memory' },
  vite: { plugins: [tailwindcss()], build: { assetsInlineLimit: (filePath: string) => /\.m?js$/.test(filePath) ? false : undefined } },
});
