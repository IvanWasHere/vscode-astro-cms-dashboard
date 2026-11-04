// Practice details used across the whole site. Edit them in the dashboard under Config → Site.
// Text that is translated is written as { en, es }.
import heroImage from '../assets/hero.svg';

export const practice = {
  name: 'Harbor View Family Medicine',
  providers: 'Sarah Mitchell, MD · Daniel Reyes, MD · Priya Shah, FNP-C',
  tagline: {
    en: 'Primary care for individuals and families in San Diego',
    es: 'Atención primaria para personas y familias en San Diego',
  },
  street: '2400 Harbor View Drive, Suite 210',
  city: 'San Diego',
  state: 'CA',
  zip: '92101',
  phone: '(619) 555-0142',
  fax: '(619) 555-0143',
  email: 'office@harborviewfamilymed.example',
  // Online booking link. Leave empty to hide the "Book online" button.
  bookingUrl: 'https://booking.example/harbor-view',
  portalUrl: 'https://portal.example/harbor-view',
  acceptingNewPatients: true,
  // Comes from `site` in astro.config.mjs (read-only in the dashboard)
  url: import.meta.env.SITE,
};

export const hero = {
  image: heroImage,
  headline: {
    en: 'Thoughtful, unhurried primary care',
    es: 'Atención primaria cercana y sin prisas',
  },
  text: {
    en: 'Our board-certified providers care for adults and families at every stage of life, from annual physicals to managing chronic conditions. Same-day appointments are available for urgent concerns.',
    es: 'Nuestros profesionales certificados atienden a adultos y familias en cada etapa de la vida, desde el examen anual hasta el control de enfermedades crónicas. Ofrecemos citas el mismo día para problemas urgentes.',
  },
};

// Notice shown at the top of every page while `show` is on.
export const notice = {
  show: true,
  text: {
    en: 'Flu shots are now available. Walk-ins welcome on Saturday mornings.',
    es: 'Ya tenemos la vacuna contra la gripe. Sin cita los sábados por la mañana.',
  },
};

// Office hours, 24-hour time. day: 1 = Monday … 7 = Sunday. Days not listed are closed.
export type Slot = { from: string; to: string };
export const hours: { day: number; slots: Slot[] }[] = [
  { day: 1, slots: [{ from: '08:00', to: '12:00' }, { from: '13:00', to: '17:00' }] },
  { day: 2, slots: [{ from: '08:00', to: '12:00' }, { from: '13:00', to: '17:00' }] },
  { day: 3, slots: [{ from: '08:00', to: '12:00' }, { from: '13:00', to: '17:00' }] },
  { day: 4, slots: [{ from: '08:00', to: '12:00' }, { from: '13:00', to: '19:00' }] },
  { day: 5, slots: [{ from: '08:00', to: '12:00' }, { from: '13:00', to: '16:00' }] },
  { day: 6, slots: [{ from: '09:00', to: '12:00' }] },
];

// Holidays and closures, shown on the hours page.
export const closures = [
  {
    from: '2026-11-26',
    to: '2026-11-26',
    reason: { en: 'Thanksgiving', es: 'Día de Acción de Gracias' },
    coverage: 'On-call physician through the main number',
  },
  {
    from: '2026-12-24',
    to: '2027-01-01',
    reason: { en: 'Winter holidays', es: 'Fiestas de fin de año' },
    coverage: 'On-call physician through the main number',
  },
];

// Insurance plans we accept. Shown on the contact page.
export const insurance = ['Aetna', 'Anthem Blue Cross', 'Blue Shield of California', 'Cigna', 'Medicare', 'Medi-Cal', 'UnitedHealthcare'];
