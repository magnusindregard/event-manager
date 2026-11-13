import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Norwegian and English from day one (ADR 0006).
const resources = {
  nb: {
    translation: {
      app: { title: "Arrangementer" },
      nav: { events: "Arrangementer", locations: "Steder", settings: "Innstillinger", members: "Brukere", audit: "Endringslogg" },
      auth: { signIn: "Logg inn", signOut: "Logg ut", devEmail: "E-post (lokal utvikling)", signedInAs: "Innlogget som {{email}}" },
      account: { choose: "Velg konto", none: "Du har ikke tilgang til noen konto ennå. Be en eier om en invitasjon.", switch: "Bytt konto" },
      settings: {
        title: "Kontoinnstillinger", name: "Navn", timezone: "Tidssone", locales: "Språk", defaultLocale: "Standardspråk",
        horizon: "Horisont for gjentakelser (måneder)", save: "Lagre", saved: "Lagret", ownerOnly: "Bare eiere kan endre innstillinger.",
      },
      members: { title: "Brukere", invite: "Inviter", email: "E-post", role: "Rolle", pending: "Venter", remove: "Fjern", roles: { owner: "Eier", editor: "Redaktør" } },
      audit: { title: "Endringslogg", when: "Tidspunkt", who: "Hvem", action: "Handling", entity: "Objekt", changes: "Endringer", loadMore: "Last flere" },
      conflict: { title: "Endret av noen andre", body: "Kontoen ble endret mens du redigerte. Last inn på nytt for å se siste versjon. Endringene dine går tapt.", reload: "Last inn på nytt", cancel: "Avbryt" },
      comingSoon: "Kommer i milepæl {{n}}.",
      error: { generic: "Noe gikk galt" },
    },
  },
  en: {
    translation: {
      app: { title: "Events" },
      nav: { events: "Events", locations: "Locations", settings: "Settings", members: "Users", audit: "Audit log" },
      auth: { signIn: "Sign in", signOut: "Sign out", devEmail: "Email (local development)", signedInAs: "Signed in as {{email}}" },
      account: { choose: "Choose account", none: "You don't have access to an account yet. Ask an owner for an invitation.", switch: "Switch account" },
      settings: {
        title: "Account settings", name: "Name", timezone: "Timezone", locales: "Languages", defaultLocale: "Default language",
        horizon: "Recurrence horizon (months)", save: "Save", saved: "Saved", ownerOnly: "Only owners can change settings.",
      },
      members: { title: "Users", invite: "Invite", email: "Email", role: "Role", pending: "Pending", remove: "Remove", roles: { owner: "Owner", editor: "Editor" } },
      audit: { title: "Audit log", when: "When", who: "Who", action: "Action", entity: "Entity", changes: "Changes", loadMore: "Load more" },
      conflict: { title: "Changed by someone else", body: "The account changed while you were editing. Reload to see the latest version. Your changes will be lost.", reload: "Reload", cancel: "Cancel" },
      comingSoon: "Coming in milestone {{n}}.",
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

export default i18n;
