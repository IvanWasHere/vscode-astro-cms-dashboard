// Endpoint: office hours as JSON, e.g. for a lobby display or a phone system.
import type { APIRoute } from 'astro';
import { hours, closures } from '../../data/site';

export const GET: APIRoute = () => new Response(JSON.stringify({ hours, closures }, null, 2), {
  headers: { 'Content-Type': 'application/json' },
});
