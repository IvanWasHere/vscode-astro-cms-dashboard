import { getCollection } from 'astro:content';
import type { Lang } from '../i18n/translations';

export async function getServices(lang: Lang) {
  const all = await getCollection('services', (s) => s.id.startsWith(`${lang}/`));
  return all.sort((a, b) => a.data.order - b.data.order);
}
