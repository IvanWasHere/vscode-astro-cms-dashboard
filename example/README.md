# Example site: Harbor View Family Medicine

A small Astro site for a **fictional** family medicine practice in San Diego, in English (default) and Spanish. It's here to try out and demo the Astro Dashboard extension. The practice, providers, address and phone numbers are made up (the numbers use the reserved 555 range).

## Run it

```sh
npm install
npm run sync   # generates .astro/collections/*.schema.json, so the dashboard reads exact field types
npm run dev    # http://localhost:4321
```

Then open this folder in VS Code with the extension installed, or press **F5** in the extension repo, which opens this folder in an Extension Development Host.

For a step-by-step walk-through with screenshots, see the [tutorial in the main README](../README.md#tutorial).

## What it shows

| Dashboard feature | Where to look in this site |
| --- | --- |
| **Translatable collection** | `news`: posts in `src/content/news/en/` and `es/`. *Holiday hours* has no Spanish version yet, so the list shows **+** to create it. |
| **Drafts** | `news/en/2026-11-new-provider.md` has `draft: true` and is not published on the site. |
| **Add a draft field** | `services` has no `draft` field. Open an entry and the publish box offers to add one. *Nutrition counseling* is English-only. |
| **Field types** | `news`: text, date, text area (`summary`), image (`cover`), tags, boolean. `services`: drop-downs (`icon`, `coverage`) and number (`order`). |
| **Data-only collection** | `team`: one YAML file per provider, no body text. `position` is an object `{ en, es }`, so it's edited as raw JSON. Maria has no headshot. |
| **View on site / link picker** | News entries link to `/news/<slug>/` and `/es/noticias/<slug>/` through the dynamic `[id].astro` pages. |
| **Media library** | Images in `src/assets/` (hero, headshots, news covers) and files in `public/`, including a PDF form. `src/assets/open-house-2019.svg` isn't used anywhere, so it shows the *unused* badge. |
| **Pages** | Pages in both languages, two dynamic routes (`news/[id]`, `es/noticias/[id]`), a 404 page and an endpoint (`api/hours.json.ts`). |
| **Config: TypeScript** | `src/data/site.ts`: practice details, notice bar (`notice.show`), office hours, closures, accepted insurance. `hero.image` is an imported image and `practice.url` is `import.meta.env.SITE`, so both are read-only with a thumbnail or *Edit in file* link. |
| **Config: translations** | `src/i18n/ui.ts`: menu labels and interface texts as `{ en, es }` pairs, shown side by side. |
| **Config: JSON and YAML** | `src/data/faq.json` (FAQ on the contact page) and `src/data/emergency.yaml` (emergency numbers in the footer). |
| **Settings** | `astro.config.mjs` with `site`, `i18n` and the sitemap integration. |

## Things to try

1. Turn off the notice bar: **Config → Site → notice → show**, save, and reload the site.
2. Change Thursday's evening hours in **Config → Site → hours**.
3. Translate *Holiday hours* into Spanish with the **+** in the news list.
4. Publish the draft *Welcoming a new nurse practitioner*.
5. Add a provider, pick a headshot from the media library, and see them on `/providers/`.
6. Add an insurance plan in **Config → Site → insurance**.
7. Create a new collection (for example `downloads`) with the wizard and look at the code it adds to `src/content.config.ts`.

Use `git checkout example/` or `git clean -fd example/` to reset the site after experimenting.
