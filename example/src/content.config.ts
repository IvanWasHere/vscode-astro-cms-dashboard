import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// News: one Markdown file per language in src/content/news/<lang>/.
const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      date: z.coerce.date(),
      summary: z.string(),
      cover: image().optional(),
      tags: z.array(z.string()).default([]),
      important: z.boolean().default(false),
      draft: z.boolean().default(false),
    }),
});

// Services shown on the services page. No draft field, so the dashboard can offer to add one.
const services = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/services' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    icon: z.enum(['stethoscope', 'heart', 'syringe', 'lab', 'video', 'leaf']),
    coverage: z.enum(['insurance', 'self-pay']).default('insurance'),
    order: z.number().default(0),
  }),
});

// Providers and staff: data only (YAML), no body text.
const team = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/team' }),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      role: z.enum(['physician', 'nurse-practitioner', 'medical-assistant', 'front-office']),
      position: z.object({ en: z.string(), es: z.string() }),
      photo: image().optional(),
      languages: z.array(z.string()).default([]),
      order: z.number().default(0),
      active: z.boolean().default(true),
    }),
});

export const collections = { news, services, team };
