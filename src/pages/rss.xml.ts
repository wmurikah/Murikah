import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SITE } from '@/site.config';

// Static feed generated at build time.
export const prerender = true;

export const GET: APIRoute = async (context) => {
  const guides = (await getCollection('insights', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  );

  return rss({
    title: `${SITE.name} · Insights`,
    description: 'Guides and articles on internal audit, AI and system governance, and assurance.',
    // context.site comes from `site` in astro.config.ts.
    site: context.site ?? SITE.url,
    items: guides.map((g) => ({
      title: g.data.title,
      description: g.data.description,
      pubDate: g.data.pubDate,
      link: `/insights/${g.id}/`,
      categories: g.data.tags,
      author: g.data.author,
    })),
    customData: '<language>en-gb</language>',
  });
};
