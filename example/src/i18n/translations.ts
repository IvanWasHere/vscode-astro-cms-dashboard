// Languages, page addresses and interface texts. English is the default, Spanish lives under /es/.
export const languages = {
  en: { label: 'English', short: 'EN', locale: 'en-US' },
  es: { label: 'Español', short: 'ES', locale: 'es-US' },
};
export type Lang = keyof typeof languages;

export const routes = {
  home: { en: '/', es: '/es/' },
  services: { en: '/services/', es: '/es/servicios/' },
  team: { en: '/providers/', es: '/es/equipo/' },
  hours: { en: '/hours/', es: '/es/horario/' },
  news: { en: '/news/', es: '/es/noticias/' },
  contact: { en: '/contact/', es: '/es/contacto/' },
  privacy: { en: '/privacy/', es: '/es/privacidad/' },
};
export type RouteKey = keyof typeof routes;

// Menu labels, in menu order
export const nav = {
  services: { en: 'Services', es: 'Servicios' },
  team: { en: 'Our providers', es: 'Nuestro equipo' },
  hours: { en: 'Hours', es: 'Horario' },
  news: { en: 'News', es: 'Noticias' },
  contact: { en: 'Contact', es: 'Contacto' },
};

export const ui = {
  call: { en: 'Call', es: 'Llame al' },
  bookOnline: { en: 'Book an appointment', es: 'Hacer una cita' },
  patientPortal: { en: 'Patient portal', es: 'Portal del paciente' },
  newPatients: { en: 'Now accepting new patients', es: 'Aceptamos pacientes nuevos' },
  latestNews: { en: 'Practice news', es: 'Noticias del consultorio' },
  allNews: { en: 'All news', es: 'Todas las noticias' },
  ourServices: { en: 'Services', es: 'Servicios' },
  servicesIntro: {
    en: 'Comprehensive primary care for adults and families, delivered in English and Spanish.',
    es: 'Atención primaria integral para adultos y familias, en inglés y en español.',
  },
  selfPay: { en: 'Self-pay', es: 'Pago directo' },
  officeHours: { en: 'Office hours', es: 'Horario de atención' },
  closed: { en: 'Closed', es: 'Cerrado' },
  closures: { en: 'Holidays and closures', es: 'Días festivos y cierres' },
  coverage: { en: 'Coverage', es: 'Atención' },
  speaks: { en: 'Languages', es: 'Idiomas' },
  location: { en: 'Location', es: 'Ubicación' },
  directions: { en: 'Get directions', es: 'Cómo llegar' },
  insurance: { en: 'Insurance accepted', es: 'Seguros aceptados' },
  insuranceNote: {
    en: 'Coverage varies by plan. Please call us to confirm before your visit.',
    es: 'La cobertura depende de su plan. Llámenos para confirmar antes de su visita.',
  },
  download: { en: 'New patient registration form (PDF)', es: 'Formulario de registro para pacientes nuevos (PDF)' },
  privacy: { en: 'Privacy & HIPAA notice', es: 'Aviso de privacidad (HIPAA)' },
  notFound: { en: 'Page not found', es: 'Página no encontrada' },
  backHome: { en: 'Back to home', es: 'Volver al inicio' },
};

export const days = {
  en: ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  es: ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'],
};

/** Picks the text for a language from an { en, es } pair. */
export const tr = (lang: Lang, pair: Record<Lang, string>) => pair[lang];

export const fmtDate = (lang: Lang, d: Date | string) =>
  // Content dates are calendar days (stored as UTC midnight), so format them in UTC
  new Date(d).toLocaleDateString(languages[lang].locale, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** '13:00' → '1:00 PM' (en) / '1:00 p. m.' (es) */
export const fmtTime = (lang: Lang, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(languages[lang].locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
};
