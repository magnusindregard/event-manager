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
      common: { language: "Språk", menu: "Meny", search: "Søk …", noResults: "Ingen treff", empty: "Ingenting her ennå", save: "Lagre", saved: "Lagret", edit: "Rediger", remove: "Fjern", delete: "Slett", actions: "Handlinger", date: "dato", time: "klokkeslett", back: "Tilbake" },
      registrations: {
        title: "Påmeldinger", open: "Påmeldinger", openFor: "Påmeldinger {{when}}", summary: "{{count}} påmeldinger, {{people}} personer",
        openPage: "Åpne påmeldingssiden", active: "Påmeldt", cancelled: "Avbestilt", empty: "Ingen påmeldinger",
        name: "Navn", email: "E-post", party: "Personer", source: "Kilde", guest: "Tar med en gjest",
        sources: { open: "Åpen påmelding", staff: "Lagt til av ansatt", invitation: "Invitasjon" },
        cancelledBy: { attendee: "Avbestilt av deltaker", staff: "Avbestilt av ansatt" },
        add: "Legg til manuelt", addButton: "Legg til", addHelp: "Bekreftes med en gang og får e-post. Påmeldingsvinduet gjelder ikke, men plassene gjør det.",
        added: "{{name}} er lagt til", cancelFor: "Avbestill for {{name}}", cancelTitle: "Avbestille for {{name}}?",
        cancelBody: "Plassen blir ledig, og deltakeren får beskjed på e-post.", cancelConfirm: "Avbestill", cancelledToast: "Påmeldingen til {{name}} er avbestilt",
        deleteBlocked: "Forekomsten har påmeldinger og kan ikke slettes. Avlys den i stedet.",
        errors: {
          full: "Det er ingen ledige plasser.", already_registered: "Denne e-postadressen er allerede påmeldt.",
          registration_closed: "Forekomsten er avlyst.", validation_failed: "Sjekk navn og e-postadresse.",
        },
      },
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
        tabs: { details: "Detaljer", occurrences: "Tidsplan", rules: "Regler", audit: "Endringslogg" },
        texts: "Tekster", defaultLocaleRequired: "Påkrevd i standardspråket", optionalLocale: "Valgfritt. Uten tittel vises standardspråket.",
        shortDescription: "Kort beskrivelse", imageUrl: "Bilde-URL", imageAlt: "Alternativ tekst for bildet",
        slug: "Slug", slugHint: "Lages fra tittelen hvis tom", timezone: "Tidssone", duration: "Standard varighet (minutter)",
        defaultLocation: "Standardsted", noLocation: "Ikke valgt", externalAdmission: "Billetter selges hos en annen leverandør",
        externalUrl: "Billettlenke", externalUrlHint: "Kan overstyres per forekomst",
        admission: "Adgang", admissionModes: { none: "Ingen påmelding", external: "Billetter selges hos en annen leverandør", registration: "Påmelding her" },
        reg: {
          accessPolicy: "Hvem kan melde seg på", policies: { open: "Alle (åpen påmelding)", invite_only: "Bare inviterte" },
          capacity: "Plasser per forekomst", capacityHint: "Kan endres med regler og per forekomst", unlimited: "Ubegrenset",
          overbooking: "Overbooking (%)", bookableLimit: "Inntil {{limit}} påmeldte per forekomst",
          opens: "Åpner (timer før start)", opensHint: "Tom: når arrangementet publiseres", whenPublished: "Ved publisering",
          closes: "Stenger (timer før start)", guestAllowed: "Gjester kan ta med én person", listed: "Vises i offentlige oversikter",
        },
        externalRefs: "Referanser i andre systemer", externalRefsHint: "F.eks. dokument-ID i Sanity. Brukes av integrasjoner.",
        refSystem: "System", refId: "ID", addRef: "Legg til referanse", noTags: "Ingen tagger", noVocabularies: "Lag tagger under Innstillinger",
      },
      occurrences: {
        places: "Plasser", placesOf: "{{taken}} av {{limit}}", placesUnlimited: "{{taken}} påmeldt", capacityPlus: "{{capacity}} + {{pct}} %",
        overLimit: "Over grensen", capacityOverride: "Plasser",
        source: { default: "standard", rule: "regel", ruleNamed: "regel: {{name}}", override: "overstyrt" },
        when: "Tid", location: "Sted", link: "Billettlenke", cancelled: "Avlyst", reinstate: "Gjeninnsett", cancel: "Avlys",
        timesIn: "Tider i {{tz}}", add: "Ny forekomst", edit: "Rediger forekomst", empty: "Ingen forekomster ennå",
        start: "Start", end: "Slutt", overrides: "Overstyringer", overridesHint: "Tomt felt arver fra arrangementet.",
        inherit: "Arv: {{value}}", overrideTags: "Egne tagger for denne forekomsten",
        deleteTitle: "Slette forekomsten?", deleteBody: "Den forsvinner fra nettsider og kalendere. Vil du heller vise den som avlyst, velg Avlys.",
      },
      series: {
        title: "Gjentakelser", add: "Ny gjentakelse", empty: "Ingen gjentakelser. Legg til en, eller enkeltforekomster under.",
        meta: "{{duration}} min · {{tz}}", generatedUntil: "laget til {{date}}, utvides hver natt",
        editAll: "Endre hele serien", editFollowing: "Endre denne og etterfølgende", delete: "Slett gjentakelsen",
        deleteTitle: "Slette gjentakelsen?",
        deleteBody: "Kommende forekomster slettes. Tidligere forekomster og de du har endret for hånd, beholdes som enkeltforekomster.",
        deleteOccurrenceBody: "Forekomsten fjernes fra serien og kommer ikke tilbake når serien endres. Vil du heller vise den som avlyst, velg Avlys.",
        deletedSummary: "Gjentakelsen er slettet: {{deleted}} forekomster fjernet, {{kept}} beholdt",
        savedSummary: "Lagret: {{created}} nye, {{moved}} flyttet, {{deleted}} fjernet, {{conflicts}} konflikter",
        keep: "Behold som den er", reattach: "Tilbakestill til serien",
        conflictHelp: "Denne forekomsten er endret for hånd, og serien er endret etterpå. Den står der den sto. Behold den, eller tilbakestill den til seriens tid uten overstyringer.",
        thisOnly: "Del av en gjentakelse. Endringer her gjelder bare denne forekomsten og løsner den fra serien.",
        thisDetached: "Endret for hånd: serien flytter den ikke lenger.",
        badge: { series: "Del av gjentakelse", conflict: "Konflikt", detached: "Endret" },
        view: { list: "Liste", calendar: "Kalender" },
        conflictReason: { moved: "serien ville flyttet den", removed: "serien har ikke lenger denne datoen" },
        summary: {
          custom: "Egendefinert: {{rule}} kl. {{time}}",
          every: {
            DAILY_one: "Hver dag", DAILY_other: "Hver {{count}}. dag",
            WEEKLY_one: "Hver uke", WEEKLY_other: "Hver {{count}}. uke",
            MONTHLY_one: "Hver måned", MONTHLY_other: "Hver {{count}}. måned",
            YEARLY_one: "Hvert år", YEARLY_other: "Hvert {{count}}. år",
          },
          on: "på {{days}}", at: "kl. {{time}}", times_one: "{{count}} gang", times_other: "{{count}} ganger",
          until: "til og med {{date}}", forever: "uten slutt",
        },
        editor: {
          title: { create: "Ny gjentakelse", edit: "Endre hele serien", split: "Endre denne og etterfølgende" },
          splitHint: "Serien deles: tidligere forekomster beholder regelen, og en ny serie starter her. Tider i {{tz}}.",
          fromDate: "Fra dato", startDate: "Startdato", time: "Klokkeslett", duration: "Varighet (minutter)", repeat: "Gjentas",
          freq: { DAILY: "Daglig", WEEKLY: "Ukentlig", MONTHLY: "Månedlig", YEARLY: "Årlig", CUSTOM: "Egendefinert (RRULE)" },
          custom: "Regel", customHint: "RFC 5545 uten DTSTART, f.eks. FREQ=MONTHLY;BYDAY=1SA. UNTIL er lokal tid.",
          interval: "Hver",
          unit: {
            DAILY_one: "dag", DAILY_other: "dager", WEEKLY_one: "uke", WEEKLY_other: "uker",
            MONTHLY_one: "måned", MONTHLY_other: "måneder", YEARLY_one: "år", YEARLY_other: "år",
          },
          weekdays: "Ukedager", ends: "Slutter",
          end: { never: "Aldri", until: "På dato", count: "Etter antall" },
          occurrences_one: "forekomst", occurrences_other: "forekomster",
          horizonHint: "Forekomster lages for planleggingshorisonten i kontoinnstillingene og utvides hver natt.",
          save: { create: "Lag gjentakelse", edit: "Lagre serien", split: "Del serien" },
        },
        preview: {
          title: "Forhåndsvisning", incomplete: "Fyll ut regelen for å se forekomstene.", loading: "Beregner …",
          counts: "{{created}} nye · {{moved}} flyttes · {{deleted}} fjernes · {{conflicts}} konflikter",
          new: "Nye forekomster", moved: "Flyttes", deleted: "Fjernes",
          conflicts_one: "{{count}} forekomst er endret for hånd og blir stående. Den merkes som konflikt.",
          conflicts_other: "{{count}} forekomster er endret for hånd og blir stående. De merkes som konflikt.",
          more: "og {{count}} til",
        },
      },
      rules: {
        intro: "Regler setter sted, tagger eller billettlenke på forekomster som passer betingelsene, også forekomster som lages senere. Per felt vinner en overstyring på forekomsten, så regelen med høyest prioritet, så arrangementets standard.",
        add: "Ny regel", edit: "Rediger regel", create: "Lag regel", empty: "Ingen regler ennå.",
        name: "Navn", namePlaceholder: "F.eks. Sommerkveld på taket",
        priority: "Prioritet", priorityHint: "Høyest vinner når flere regler passer.", priorityBadge: "prioritet {{priority}}",
        active: "Aktiv", inactive: "Av", thisRule: "denne regelen",
        when: "Når", dateFrom: "Fra dato", dateTo: "Til og med dato", weekdays: "Ukedager", weekdaysHint: "Ingen valgt betyr alle dager.",
        timeFrom: "Starter kl. eller senere", timeTo: "Starter før kl.", timeToHint: "Tidligere enn fra-tiden går over midnatt.",
        then: "Så", setLocation: "Sett sted", chooseLocation: "Velg sted", changeTags: "Endre tagger",
        addTags: "Legg til", removeTags: "Fjern", setLink: "Sett billettlenke",
        editorHint: "Betingelsene gjelder starttid i {{tz}}.",
        saved_one: "Regelen er lagret. {{count}} forekomst endret.", saved_other: "Regelen er lagret. {{count}} forekomster endret.",
        savedQueued_one: "Regelen er lagret. {{count}} forekomst oppdateres i bakgrunnen.", savedQueued_other: "Regelen er lagret. {{count}} forekomster oppdateres i bakgrunnen.",
        deleted_one: "Regelen er slettet. {{count}} forekomst endret.", deleted_other: "Regelen er slettet. {{count}} forekomster endret.",
        deleteTitle: "Slette «{{name}}»?", deleteBody: "Forekomstene den gjelder, faller tilbake til andre regler eller arrangementets standard.",
        field: { location: "Sted", tags: "Tagger", externalUrl: "Billettlenke" },
        effect: { location: "Sted", tags: "Tagger", externalUrl: "Lenke", capacity: "Plasser", overbooking: "Overbooking" },
        set_capacity: "Sett antall plasser", set_overbooking: "Sett overbooking (%)",
        summary: { fromDate: "fra {{date}}", toDate: "til og med {{date}}", between: "starter {{from}}–{{to}}", fromTime: "starter kl. {{time}} eller senere", beforeTime: "starter før kl. {{time}}", all: "Alle forekomster" },
        preview: {
          incomplete: "Gi regelen et navn og minst én virkning for å se hva den gjør.",
          counts: "Passer {{matched}} · {{changed}} endres · {{overridden}} beholder overstyring · {{conflicts}} konflikter",
          inactive: "Regelen er av og endrer ingenting før den slås på.",
          conflicts_one: "På {{count}} forekomst har en annen regel samme prioritet. Den eldste vinner. Gi en av dem høyere prioritet:",
          conflicts_other: "På {{count}} forekomster har en annen regel samme prioritet. Den eldste vinner. Gi en av dem høyere prioritet:",
        },
      },
      filter: {
        title: "Filter", startsFrom: "Starter fra kl.", startsBefore: "Starter før kl.", scheduled: "Planlagt", clear: "Nullstill",
        saveAsRule: "Lagre som regel", saveAsRuleHint: "Bare dato, ukedag og tid kan bli en regel. Fjern sted- og statusfilteret først.",
        showing_one: "Viser {{count}} av {{total}}", showing_other: "Viser {{count}} av {{total}}", none: "Ingen forekomster passer filteret",
      },
      bulk: {
        region: "Massehandlinger", select: "Velg", selectAll: "Velg alle som vises",
        selected_one: "{{count}} valgt", selected_other: "{{count}} valgt", override: "Overstyr …", clear: "Fjern valg",
        title_one: "Overstyr {{count}} forekomst", title_other: "Overstyr {{count}} forekomster",
        hint: "Kryss av feltene som skal endres. Andre felt beholdes som de er.",
        changeLocation: "Sted", inherit: "Arv (ingen overstyring)", changeLink: "Billettlenke", emptyInherits: "Tomt felt fjerner overstyringen.",
        changeTags: "Tagger", tagsInherit: "Arv tagger i stedet", tagsInheritOn: "Taggene arves fra arrangementet og regler.",
        detachHint: "Forekomster i en gjentakelse løsnes fra serien når de overstyres, som ved enkeltendringer.",
        apply_one: "Endre {{count}} forekomst", apply_other: "Endre {{count}} forekomster",
        saved_one: "{{count}} forekomst endret", saved_other: "{{count}} forekomster endret",
        cancelled_one: "{{count}} forekomst avlyst", cancelled_other: "{{count}} forekomster avlyst",
        reinstated_one: "{{count}} forekomst gjeninnsatt", reinstated_other: "{{count}} forekomster gjeninnsatt",
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
      common: { language: "Language", menu: "Menu", search: "Search…", noResults: "No results", empty: "Nothing here yet", save: "Save", saved: "Saved", edit: "Edit", remove: "Remove", delete: "Delete", actions: "Actions", date: "date", time: "time", back: "Back" },
      registrations: {
        title: "Registrations", open: "Registrations", openFor: "Registrations {{when}}", summary: "{{count}} registrations, {{people}} people",
        openPage: "Open the registration page", active: "Registered", cancelled: "Cancelled", empty: "No registrations",
        name: "Name", email: "Email", party: "People", source: "Source", guest: "Brings a guest",
        sources: { open: "Open registration", staff: "Added by staff", invitation: "Invitation" },
        cancelledBy: { attendee: "Cancelled by attendee", staff: "Cancelled by staff" },
        add: "Add by hand", addButton: "Add", addHelp: "Confirmed at once and emailed. The registration window does not apply; the places do.",
        added: "{{name}} has been added", cancelFor: "Cancel for {{name}}", cancelTitle: "Cancel for {{name}}?",
        cancelBody: "The place comes free, and the attendee is told by email.", cancelConfirm: "Cancel registration", cancelledToast: "{{name}}'s registration is cancelled",
        deleteBlocked: "The occurrence has registrations and cannot be deleted. Cancel it instead.",
        errors: {
          full: "There are no places left.", already_registered: "This email address is already registered.",
          registration_closed: "The occurrence is cancelled.", validation_failed: "Check the name and email address.",
        },
      },
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
        tabs: { details: "Details", occurrences: "Schedule", rules: "Rules", audit: "Audit log" },
        texts: "Texts", defaultLocaleRequired: "Required in the default language", optionalLocale: "Optional. Without a title, the default language is shown.",
        shortDescription: "Short description", imageUrl: "Image URL", imageAlt: "Image alt text",
        slug: "Slug", slugHint: "Made from the title if empty", timezone: "Timezone", duration: "Default duration (minutes)",
        defaultLocation: "Default location", noLocation: "None", externalAdmission: "Tickets are sold by another vendor",
        externalUrl: "Ticket link", externalUrlHint: "Can be overridden per occurrence",
        admission: "Admission", admissionModes: { none: "No registration", external: "Tickets are sold by another vendor", registration: "Registration here" },
        reg: {
          accessPolicy: "Who can register", policies: { open: "Anyone (open registration)", invite_only: "Invited guests only" },
          capacity: "Places per occurrence", capacityHint: "Rules and occurrences can change it", unlimited: "Unlimited",
          overbooking: "Overbooking (%)", bookableLimit: "Up to {{limit}} registrations per occurrence",
          opens: "Opens (hours before start)", opensHint: "Empty: when the event is published", whenPublished: "When published",
          closes: "Closes (hours before start)", guestAllowed: "Guests may bring one person", listed: "Shown in public listings",
        },
        externalRefs: "References in other systems", externalRefsHint: "E.g. a Sanity document ID. Used by integrations.",
        refSystem: "System", refId: "ID", addRef: "Add reference", noTags: "No tags", noVocabularies: "Create tags under Settings",
      },
      occurrences: {
        places: "Places", placesOf: "{{taken}} of {{limit}}", placesUnlimited: "{{taken}} registered", capacityPlus: "{{capacity}} + {{pct}} %",
        overLimit: "Over the limit", capacityOverride: "Places",
        source: { default: "default", rule: "rule", ruleNamed: "rule: {{name}}", override: "override" },
        when: "When", location: "Location", link: "Ticket link", cancelled: "Cancelled", reinstate: "Reinstate", cancel: "Cancel",
        timesIn: "Times in {{tz}}", add: "Add occurrence", edit: "Edit occurrence", empty: "No occurrences yet",
        start: "Start", end: "End", overrides: "Overrides", overridesHint: "Leave a field empty to inherit from the event.",
        inherit: "Inherit: {{value}}", overrideTags: "Own tags for this occurrence",
        deleteTitle: "Delete this occurrence?", deleteBody: "It disappears from websites and calendars. To show it as cancelled instead, choose Cancel.",
      },
      series: {
        title: "Recurrence", add: "Add recurrence", empty: "No recurrence. Add one, or single occurrences below.",
        meta: "{{duration}} min · {{tz}}", generatedUntil: "generated to {{date}}, extended nightly",
        editAll: "Edit entire series", editFollowing: "Edit this and following", delete: "Delete recurrence",
        deleteTitle: "Delete this recurrence?",
        deleteBody: "Upcoming occurrences are deleted. Past occurrences and ones you edited by hand are kept as single occurrences.",
        deleteOccurrenceBody: "The occurrence is removed from the series and does not come back when the series changes. To show it as cancelled instead, choose Cancel.",
        deletedSummary: "Recurrence deleted: {{deleted}} occurrences removed, {{kept}} kept",
        savedSummary: "Saved: {{created}} new, {{moved}} moved, {{deleted}} removed, {{conflicts}} conflicts",
        keep: "Keep as is", reattach: "Reset to series",
        conflictHelp: "This occurrence was edited by hand, and the series changed afterwards. It stayed where it was. Keep it, or reset it to the series' time without overrides.",
        thisOnly: "Part of a recurrence. Changes here apply to this occurrence only and detach it from the series.",
        thisDetached: "Edited by hand: the series no longer moves it.",
        badge: { series: "Part of a recurrence", conflict: "Conflict", detached: "Edited" },
        view: { list: "List", calendar: "Calendar" },
        conflictReason: { moved: "the series would have moved it", removed: "the series no longer has this date" },
        summary: {
          custom: "Custom: {{rule}} at {{time}}",
          every: {
            DAILY_one: "Every day", DAILY_other: "Every {{count}} days",
            WEEKLY_one: "Every week", WEEKLY_other: "Every {{count}} weeks",
            MONTHLY_one: "Every month", MONTHLY_other: "Every {{count}} months",
            YEARLY_one: "Every year", YEARLY_other: "Every {{count}} years",
          },
          on: "on {{days}}", at: "at {{time}}", times_one: "{{count}} time", times_other: "{{count}} times",
          until: "until {{date}}", forever: "no end date",
        },
        editor: {
          title: { create: "Add recurrence", edit: "Edit entire series", split: "Edit this and following" },
          splitHint: "The series is split: earlier occurrences keep the rule, and a new series starts here. Times in {{tz}}.",
          fromDate: "From date", startDate: "Start date", time: "Time", duration: "Duration (minutes)", repeat: "Repeats",
          freq: { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Yearly", CUSTOM: "Custom (RRULE)" },
          custom: "Rule", customHint: "RFC 5545 without DTSTART, e.g. FREQ=MONTHLY;BYDAY=1SA. UNTIL is local time.",
          interval: "Every",
          unit: {
            DAILY_one: "day", DAILY_other: "days", WEEKLY_one: "week", WEEKLY_other: "weeks",
            MONTHLY_one: "month", MONTHLY_other: "months", YEARLY_one: "year", YEARLY_other: "years",
          },
          weekdays: "Weekdays", ends: "Ends",
          end: { never: "Never", until: "On date", count: "After" },
          occurrences_one: "occurrence", occurrences_other: "occurrences",
          horizonHint: "Occurrences are generated for the planning horizon in account settings and extended nightly.",
          save: { create: "Add recurrence", edit: "Save series", split: "Split series" },
        },
        preview: {
          title: "Preview", incomplete: "Complete the rule to see the occurrences.", loading: "Working it out…",
          counts: "{{created}} new · {{moved}} move · {{deleted}} removed · {{conflicts}} conflicts",
          new: "New occurrences", moved: "Moving", deleted: "Removed",
          conflicts_one: "{{count}} occurrence was edited by hand and stays where it is. It is flagged as a conflict.",
          conflicts_other: "{{count}} occurrences were edited by hand and stay where they are. They are flagged as conflicts.",
          more: "and {{count}} more",
        },
      },
      rules: {
        intro: "Rules set the location, tags or ticket link on occurrences that meet their conditions, including occurrences created later. Per field, an override on the occurrence wins, then the highest-priority rule, then the event default.",
        add: "Add rule", edit: "Edit rule", create: "Create rule", empty: "No rules yet.",
        name: "Name", namePlaceholder: "E.g. Summer evenings on the rooftop",
        priority: "Priority", priorityHint: "The highest wins when several rules match.", priorityBadge: "priority {{priority}}",
        active: "Active", inactive: "Off", thisRule: "this rule",
        when: "When", dateFrom: "From date", dateTo: "To date (inclusive)", weekdays: "Weekdays", weekdaysHint: "None selected means every day.",
        timeFrom: "Starts at or after", timeTo: "Starts before", timeToHint: "Earlier than the from time wraps past midnight.",
        then: "Then", setLocation: "Set location", chooseLocation: "Choose a location", changeTags: "Change tags",
        addTags: "Add", removeTags: "Remove", setLink: "Set ticket link",
        editorHint: "Conditions apply to the start time in {{tz}}.",
        saved_one: "Rule saved. {{count}} occurrence changed.", saved_other: "Rule saved. {{count}} occurrences changed.",
        savedQueued_one: "Rule saved. {{count}} occurrence is being updated in the background.", savedQueued_other: "Rule saved. {{count}} occurrences are being updated in the background.",
        deleted_one: "Rule deleted. {{count}} occurrence changed.", deleted_other: "Rule deleted. {{count}} occurrences changed.",
        deleteTitle: "Delete “{{name}}”?", deleteBody: "The occurrences it applies to fall back to other rules or the event default.",
        field: { location: "Location", tags: "Tags", externalUrl: "Ticket link" },
        effect: { location: "Location", tags: "Tags", externalUrl: "Link", capacity: "Places", overbooking: "Overbooking" },
        set_capacity: "Set places", set_overbooking: "Set overbooking (%)",
        summary: { fromDate: "from {{date}}", toDate: "until {{date}}", between: "starts {{from}}–{{to}}", fromTime: "starts at {{time}} or later", beforeTime: "starts before {{time}}", all: "All occurrences" },
        preview: {
          incomplete: "Name the rule and give it at least one effect to see what it does.",
          counts: "Matches {{matched}} · {{changed}} change · {{overridden}} keep an override · {{conflicts}} conflicts",
          inactive: "The rule is off and changes nothing until it is switched on.",
          conflicts_one: "On {{count}} occurrence another rule has the same priority. The older one wins. Give one of them a higher priority:",
          conflicts_other: "On {{count}} occurrences another rule has the same priority. The older one wins. Give one of them a higher priority:",
        },
      },
      filter: {
        title: "Filter", startsFrom: "Starts from", startsBefore: "Starts before", scheduled: "Scheduled", clear: "Clear filter",
        saveAsRule: "Save as rule", saveAsRuleHint: "Only date, weekday and time can become a rule. Clear the location and status filters first.",
        showing_one: "Showing {{count}} of {{total}}", showing_other: "Showing {{count}} of {{total}}", none: "No occurrences match the filter",
      },
      bulk: {
        region: "Bulk actions", select: "Select", selectAll: "Select all shown",
        selected_one: "{{count}} selected", selected_other: "{{count}} selected", override: "Override…", clear: "Clear selection",
        title_one: "Override {{count}} occurrence", title_other: "Override {{count}} occurrences",
        hint: "Tick the fields to change. Other fields stay as they are.",
        changeLocation: "Location", inherit: "Inherit (no override)", changeLink: "Ticket link", emptyInherits: "Leave empty to remove the override.",
        changeTags: "Tags", tagsInherit: "Inherit tags instead", tagsInheritOn: "Tags are inherited from the event and rules.",
        detachHint: "Occurrences in a recurrence are detached from the series when overridden, as with single edits.",
        apply_one: "Change {{count}} occurrence", apply_other: "Change {{count}} occurrences",
        saved_one: "{{count}} occurrence changed", saved_other: "{{count}} occurrences changed",
        cancelled_one: "{{count}} occurrence cancelled", cancelled_other: "{{count}} occurrences cancelled",
        reinstated_one: "{{count}} occurrence reinstated", reinstated_other: "{{count}} occurrences reinstated",
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
