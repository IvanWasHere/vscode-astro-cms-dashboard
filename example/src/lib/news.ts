// News posts for one language, newest first, without drafts.
import { getCollection, type CollectionEntry } from 'astro:content';
import { routes, type Lang } from '../i18n/ui';

/** "es/2026-10-flu-shots" → "2026-10-flu-shots" */
export const slugOf = (id: string) => id.split('/').slice(1).join('/');

export async function getNews(lang: Lang) {
  const posts = await getCollection('news', (p) => p.id.startsWith(`${lang}/`) && !p.data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export const newsUrl = (lang: Lang, post: CollectionEntry<'news'>) => `${routes.news[lang]}${slugOf(post.id)}/`;
