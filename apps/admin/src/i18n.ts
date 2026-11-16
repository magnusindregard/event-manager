import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Norwegian and English from day one (ADR 0006).
const resources = {
  nb: {
    translation: {
      app: { title: "Arrangementer" },
      nav: { events: "Arrangementer", locations: "Steder", settings: "Innstillinger", members: "Brukere", audit: "Endringslogg" },
      auth: { signIn: "Logg inn", signOut: "Logg ut", devEmail: "E-post (lokal utvikling)", signedInAs: "Innlogget som {{email}}", failed: "Innloggingen feilet. Sjekk Entra-innstillingene." },
      account: { choose: "Velg konto", none: "Du har ikke tilgang til noen konto ennå. Be en eier om en invitasjon.", switch: "Bytt konto" },
      settings: {
        title: "Kontoinnstillinger", name: "Navn", timezone: "Tidssone", locales: "Språk", defaultLocale: "Standardspråk",
        horizon: "Horisont for gjentakelser (måneder)", save: "Lagre", saved: "Lagret", ownerOnly: "Bare eiere kan endre innstillinger.",
      },
      members: {
        title: "Brukere", user: "Bruker", invite: "Inviter", email: "E-post", role: "Rolle", pending: "Venter", remove: "Fjern", roles: { owner: "Eier", editor: "Redaktør" },
        signin: "Innlogging", signinKinds: { auto: "Finn ut automatisk", work: "Jobbkonto", local: "Engangskode på e-post" },
        provisioning: { pending: "Lager innlogging …", provisioned: "Innlogging klar ({{kind}})", failed: "Kunne ikke lage innlogging" },
        emailSent: "E-post sendt", retry: "Prøv igjen og send e-post på nytt",
      },
      audit: { title: "Endringslogg", when: "Tidspunkt", who: "Hvem", action: "Handling", entity: "Objekt", changes: "Endringer", loadMore: "Last flere" },
      conflict: { title: "Endret av noen andre", body: "Dette ble endret av noen andre mens du redigerte. Last inn på nytt for å se siste versjon. Endringene dine går tapt.", reload: "Last inn på nytt", cancel: "Avbryt" },
      common: { language: "Språk", menu: "Meny", search: "Søk …", noResults: "Ingen treff", empty: "Ingenting her ennå", save: "Lagre", saved: "Lagret", edit: "Rediger", remove: "Fjern", delete: "Slett", actions: "Handlinger", date: "dato", time: "klokkeslett" },
      locations: {
        title: "Steder", description: "Bygg (venues) med rom og soner (spaces).", addVenue: "Nytt bygg", addSpace: "Nytt rom", edit: "Rediger sted",
        name: "Navn", address: "Adresse", lat: "Breddegrad", lng: "Lengdegrad", archived: "Arkivert", archive: "Arkiver", restore: "Gjenopprett",
        showArchived: "Vis arkiverte", empty: "Ingen steder ennå. Start med et bygg.", inVenue: "I {{venue}}", wholeVenue: "hele bygget",
      },
      events: {
        listTitle: "Arrangementer", new: "Nytt arrangement", create: "Opprett", title: "Tittel", status: "Status",
        statuses: { draft: "Utkast", published: "Publisert", cancelled: "Avlyst", archived: "Arkivert" },
        next: "Neste", occurrences: "Forekomster", tags: "Tagger", allStatuses: "Alle statuser", allTags: "Alle tagger", allLocations: "Alle steder",
        empty: "Ingen arrangementer", notFound: "Fant ikke arrangementet",
        actions: { publish: "Publiser", unpublish: "Avpubliser", cancel: "Avlys", archive: "Arkiver" },
        tabs: { details: "Detaljer", occurrences: "Forekomster", audit: "Endringslogg" },
        texts: "Tekster", defaultLocaleRequired: "Påkrevd i standardspråket", optionalLocale: "Valgfritt. Uten tittel vises standardspråket.",
        shortDescription: "Kort beskrivelse", imageUrl: "Bilde-URL", imageAlt: "Alternativ tekst for bildet",
        slug: "Slug", slugHint: "Lages fra tittelen hvis tom", timezone: "Tidssone", duration: "Standard varighet (minutter)",
        defaultLocation: "Standardsted", noLocation: "Ikke valgt", externalAdmission: "Billetter selges hos en annen leverandør",
        externalUrl: "Billettlenke", externalUrlHint: "Kan overstyres per forekomst",
        externalRefs: "Referanser i andre systemer", externalRefsHint: "F.eks. dokument-ID i Sanity. Brukes av integrasjoner.",
        refSystem: "System", refId: "ID", addRef: "Legg til referanse", noTags: "Ingen tagger", noVocabularies: "Lag tagger under Innstillinger",
      },
      occurrences: {
        source: { default: "standard", rule: "regel", override: "overstyrt" },
        when: "Tid", location: "Sted", link: "Billettlenke", cancelled: "Avlyst", reinstate: "Gjeninnsett", cancel: "Avlys",
        timesIn: "Tider i {{tz}}", add: "Ny forekomst", edit: "Rediger forekomst", empty: "Ingen forekomster ennå",
        start: "Start", end: "Slutt", overrides: "Overstyringer", overridesHint: "Tomt felt arver fra arrangementet.",
        inherit: "Arv: {{value}}", overrideTags: "Egne tagger for denne forekomsten",
        deleteTitle: "Slette forekomsten?", deleteBody: "Den forsvinner fra nettsider og kalendere. Vil du heller vise den som avlyst, velg Avlys.",
      },
      tags: {
        title: "Tagger", description: "Ordlister som kategori og målgruppe. Brukes til filtrering på nettsider.",
        noTags: "Ingen tagger ennå", newTag: "Ny tagg", addTag: "Legg til", newVocabulary: "Ny ordliste", addVocabulary: "Legg til ordliste",
      },
      apiKeys: {
        title: "API-nøkler", description: "Nøkler for nettsider og CMS som leser det offentlige API-et.",
        copyNow: "Kopier nøkkelen nå. Den vises bare denne ene gangen.", copy: "Kopier", copied: "Kopiert",
        label: "Navn", kind: "Type", kinds: { publishable: "Publiserbar", preview: "Forhåndsvisning" }, create: "Lag nøkkel",
        hints: {
          publishable: "Publiserbare nøkler kan ligge i nettleseren. De viser bare publiserte arrangementer.",
          preview: "Forhåndsvisningsnøkler viser også utkast. Bruk dem bare på en server, aldri i nettleseren.",
        },
        created: "Opprettet", revoke: "Trekk tilbake", revoked: "Tilbaketrukket", empty: "Ingen nøkler ennå",
      },
      error: { generic: "Noe gikk galt" },
    },
  },
  en: {
    translation: {
      app: { title: "Events" },
      nav: { events: "Events", locations: "Locations", settings: "Settings", members: "Users", audit: "Audit log" },
      auth: { signIn: "Sign in", signOut: "Sign out", devEmail: "Email (local development)", signedInAs: "Signed in as {{email}}", failed: "Sign-in failed. Check the Entra settings." },
      account: { choose: "Choose account", none: "You don't have access to an account yet. Ask an owner for an invitation.", switch: "Switch account" },
      settings: {
        title: "Account settings", name: "Name", timezone: "Timezone", locales: "Languages", defaultLocale: "Default language",
        horizon: "Recurrence horizon (months)", save: "Save", saved: "Saved", ownerOnly: "Only owners can change settings.",
      },
      members: {
        title: "Users", user: "User", invite: "Invite", email: "Email", role: "Role", pending: "Pending", remove: "Remove", roles: { owner: "Owner", editor: "Editor" },
        signin: "Sign-in", signinKinds: { auto: "Detect automatically", work: "Work account", local: "One-time code by email" },
        provisioning: { pending: "Setting up sign-in…", provisioned: "Sign-in ready ({{kind}})", failed: "Could not set up sign-in" },
        emailSent: "Email sent", retry: "Retry and resend email",
      },
      audit: { title: "Audit log", when: "When", who: "Who", action: "Action", entity: "Entity", changes: "Changes", loadMore: "Load more" },
      conflict: { title: "Changed by someone else", body: "Someone else changed this while you were editing. Reload to see the latest version. Your changes will be lost.", reload: "Reload", cancel: "Cancel" },
      common: { language: "Language", menu: "Menu", search: "Search…", noResults: "No results", empty: "Nothing here yet", save: "Save", saved: "Saved", edit: "Edit", remove: "Remove", delete: "Delete", actions: "Actions", date: "date", time: "time" },
      locations: {
        title: "Locations", description: "Venues and the spaces inside them.", addVenue: "New venue", addSpace: "New space", edit: "Edit location",
        name: "Name", address: "Address", lat: "Latitude", lng: "Longitude", archived: "Archived", archive: "Archive", restore: "Restore",
        showArchived: "Show archived", empty: "No locations yet. Start with a venue.", inVenue: "In {{venue}}", wholeVenue: "whole venue",
      },
      events: {
        listTitle: "Events", new: "New event", create: "Create", title: "Title", status: "Status",
        statuses: { draft: "Draft", published: "Published", cancelled: "Cancelled", archived: "Archived" },
        next: "Next", occurrences: "Occurrences", tags: "Tags", allStatuses: "All statuses", allTags: "All tags", allLocations: "All locations",
        empty: "No events", notFound: "Event not found",
        actions: { publish: "Publish", unpublish: "Unpublish", cancel: "Cancel event", archive: "Archive" },
        tabs: { details: "Details", occurrences: "Occurrences", audit: "Audit log" },
        texts: "Texts", defaultLocaleRequired: "Required in the default language", optionalLocale: "Optional. Without a title, the default language is shown.",
        shortDescription: "Short description", imageUrl: "Image URL", imageAlt: "Image alt text",
        slug: "Slug", slugHint: "Made from the title if empty", timezone: "Timezone", duration: "Default duration (minutes)",
        defaultLocation: "Default location", noLocation: "None", externalAdmission: "Tickets are sold by another vendor",
        externalUrl: "Ticket link", externalUrlHint: "Can be overridden per occurrence",
        externalRefs: "References in other systems", externalRefsHint: "E.g. a Sanity document ID. Used by integrations.",
        refSystem: "System", refId: "ID", addRef: "Add reference", noTags: "No tags", noVocabularies: "Create tags under Settings",
      },
      occurrences: {
        source: { default: "default", rule: "rule", override: "override" },
        when: "When", location: "Location", link: "Ticket link", cancelled: "Cancelled", reinstate: "Reinstate", cancel: "Cancel",
        timesIn: "Times in {{tz}}", add: "Add occurrence", edit: "Edit occurrence", empty: "No occurrences yet",
        start: "Start", end: "End", overrides: "Overrides", overridesHint: "Leave a field empty to inherit from the event.",
        inherit: "Inherit: {{value}}", overrideTags: "Own tags for this occurrence",
        deleteTitle: "Delete this occurrence?", deleteBody: "It disappears from websites and calendars. To show it as cancelled instead, choose Cancel.",
      },
      tags: {
        title: "Tags", description: "Vocabularies such as category and audience. Websites filter on them.",
        noTags: "No tags yet", newTag: "New tag", addTag: "Add", newVocabulary: "New vocabulary", addVocabulary: "Add vocabulary",
      },
      apiKeys: {
        title: "API keys", description: "Keys for websites and CMSes that read the public API.",
        copyNow: "Copy the key now. It is shown only this once.", copy: "Copy", copied: "Copied",
        label: "Name", kind: "Type", kinds: { publishable: "Publishable", preview: "Preview" }, create: "Create key",
        hints: {
          publishable: "Publishable keys are safe in browsers. They only show published events.",
          preview: "Preview keys also show drafts. Use them on a server only, never in a browser.",
        },
        created: "Created", revoke: "Revoke", revoked: "Revoked", empty: "No keys yet",
      },
      error: { generic: "Something went wrong" },
    },
  },
};

const stored = (() => {
  try {
    return localStorage.getItem("em.lang");
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources,
  lng: stored ?? (navigator.language.startsWith("en") ? "en" : "nb"),
  fallbackLng: "nb",
  interpolation: { escapeValue: false },
});

export const LANGUAGES = [
  { code: "nb", label: "Norsk" },
  { code: "en", label: "English" },
] as const;

export function setLanguage(code: string) {
  void i18n.changeLanguage(code);
  try {
    localStorage.setItem("em.lang", code);
  } catch {
    /* ignore */
  }
}

// Keep <html lang> in step so screen readers and Intl pick the right language.
document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
