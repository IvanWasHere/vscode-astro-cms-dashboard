import { getCollection } from 'astro:content';

export async function getTeam() {
  const all = await getCollection('team', (m) => m.data.active);
  return all.sort((a, b) => a.data.order - b.data.order);
}
