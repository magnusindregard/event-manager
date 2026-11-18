import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { DomainError } from "@event-manager/domain";
import { html, page, raw, type Raw } from "./html.js";
import { answerList, answersFromForm, answersToForm, errorField, type FieldError, formFields, type FormValues } from "./form-fields.js";
import { formatWhen, type Texts, textsFor } from "./i18n.js";
import type { RateLimiter } from "./rate-limit.js";
import { type AttendeeService, type Details, type InvitationDetails, preferredLocale } from "./service.js";

// Hosted attendee pages (docs/registration.md, "Attendee pages"):
//   /r/{occurrence}  open registration
//   /i/{token}       an invitation: pick a time and accept, or decline
//   /m/{token}       see, change or cancel a registration; leave the waitlist, or claim or
//                    decline a waitlist offer (the offer email links here)
// Forms post back to the same URL and redirect (post/redirect/get). Basic bot protection:
// a hidden honeypot field, a minimum time on the form and a per-IP rate limit on posts.

type Form = Record<string, string | undefined>;
const MIN_FORM_MS = 1500;

const lang = (req: FastifyRequest) => (req.query as { lang?: string }).lang ?? preferredLocale(req.headers["accept-language"]);

function send(reply: FastifyReply, status: number, body: string) {
  return reply.status(status).type("text/html; charset=utf-8").send(body);
}

function notFound(reply: FastifyReply, locale: string, invalidLink = false) {
  const t = textsFor(locale);
  return send(reply, 404, page({ locale, title: t.notFound, body: html`<h1>${t.notFound}</h1><p>${invalidLink ? t.invalidLink : ""}</p>` }));
}

const whereText = (l: Details["target"]["location"]) =>
  l ? [l.venue && l.venue !== l.name ? `${l.name}, ${l.venue}` : l.name, l.address].filter(Boolean).join(" · ") : null;

const errorText = (t: Texts, e: unknown): string => {
  if (e instanceof DomainError && e.code in t.errors) return t.errors[e.code as keyof Texts["errors"]];
  return t.errors.generic;
};

function eventBlock(d: Details): Raw {
  const { target } = d;
  const where = target.location ? [target.location.venue && target.location.venue !== target.location.name ? `${target.location.name}, ${target.location.venue}` : target.location.name, target.location.address].filter(Boolean).join(" · ") : null;
  return html`
${d.image ? html`<img class="hero" src="${d.image.url}" alt="${d.image.alt ?? ""}">` : ""}
<h1>${d.title}</h1>
<ul class="meta">
  <li>${formatWhen(d.locale, target.event.timezone, target.occurrence.startUtc, target.occurrence.endUtc)}</li>
  ${where ? html`<li>${where}</li>` : ""}
</ul>
${d.shortDescription ? html`<p class="muted">${d.shortDescription}</p>` : ""}`;
}

function availabilityBadge(d: Details, t: Texts): Raw {
  if (d.target.occurrence.status === "cancelled" || d.target.event.status === "cancelled") return html`<p><span class="status cancelled">${t.cancelledOccurrence}</span></p>`;
  const a = d.availability;
  if (a.status === "closed" && a.opensAt && d.now < a.opensAt) return html`<p><span class="status closed">${t.opensAt(formatWhen(d.locale, d.target.event.timezone, a.opensAt))}</span></p>`;
  return html`<p><span class="status ${a.status}">${t[a.status]}</span></p>`;
}

const langLinks = (d: Details, base: string) =>
  d.locales.length > 1 ? d.locales.filter((l) => l !== d.locale).map((l) => ({ locale: l, href: `${base}?lang=${encodeURIComponent(l)}` })) : [];

/** Answers and consent from a posted form, for the domain. */
const answerInput = (fields: Details["form"]["fields"], form: Form) => ({ answers: answersFromForm(fields, form as FormValues), consent: form.consent === "1" });

function registrationForm(d: Details, t: Texts, action: string, values: Form, error: string | null, now: Date, fieldError: FieldError): Raw {
  const waitlist = d.availability.status === "waitlist";
  return html`
<form class="card" method="post" action="${action}" novalidate>
  <h2 style="margin-top:0">${waitlist ? t.joinWaitlistFor : t.registerFor} ${d.title}</h2>
  ${waitlist ? html`<p class="muted">${t.waitlistHelp}</p>` : ""}
  ${error ? html`<p class="notice error" role="alert">${error}</p>` : ""}
  <input type="hidden" name="locale" value="${d.locale}">
  <input type="hidden" name="t" value="${now.getTime()}">
  <div class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <label for="name">${t.name}</label>
  <input type="text" id="name" name="name" required maxlength="200" autocomplete="name" value="${values.name ?? ""}">
  <label for="email">${t.email}</label>
  <input type="email" id="email" name="email" required maxlength="254" autocomplete="email" aria-describedby="email-help" value="${values.email ?? ""}">
  <p class="help" id="email-help">${t.emailHelp}</p>
  ${d.target.event.guestAllowed ? html`<label class="check"><input type="checkbox" name="guest" value="1"${values.guest ? raw(" checked") : ""}> ${t.guest}</label>` : ""}
  ${formFields(d.form, t, d.locale, d.account.name, values, fieldError)}
  <button type="submit">${waitlist ? t.joinWaitlist : t.submit}</button>
</form>`;
}

function invitationForm(d: InvitationDetails, t: Texts, action: string, values: Form, fieldError: FieldError): Raw {
  const inv = d.invitation;
  const bookable = d.options.filter((o) => o.bookable);
  const single = d.options.length === 1 ? d.options[0]! : null;
  const chosen = values.occurrenceId ?? (bookable.length === 1 ? bookable[0]!.target.occurrence.id : undefined);
  const tz = d.event.timezone;
  const times = single
    ? html`<ul class="meta"><li>${formatWhen(d.locale, tz, single.target.occurrence.startUtc, single.target.occurrence.endUtc)}</li>${whereText(single.target.location) ? html`<li>${whereText(single.target.location)}</li>` : ""}</ul>
      ${single.bookable ? html`<input type="hidden" name="occurrenceId" value="${single.target.occurrence.id}">` : html`<p><span class="status ${single.availability.status}">${t[single.availability.status]}</span></p>`}`
    : d.options.length > 1
      ? html`<fieldset><legend>${t.chooseTime}</legend>${d.options.map((o) => html`
<label class="option"><input type="radio" name="occurrenceId" value="${o.target.occurrence.id}"${o.target.occurrence.id === chosen ? raw(" checked") : ""}${o.bookable ? "" : raw(" disabled")} required>
<span><span class="when">${formatWhen(d.locale, tz, o.target.occurrence.startUtc, o.target.occurrence.endUtc)}</span>${whereText(o.target.location) ? html`<span class="where">${whereText(o.target.location)}</span>` : ""}${o.availability.status !== "available" ? html`<span class="status ${o.availability.status}">${t[o.availability.status]}</span>` : ""}</span></label>`)}</fieldset>`
      : html`<p class="muted">${t.noTimes}</p>`;
  return html`
<form class="card" method="post" action="${action}" novalidate>
  <h2 style="margin-top:0">${t.invitationTitle}</h2>
  <input type="hidden" name="locale" value="${d.locale}">
  ${times}
  ${bookable.length ? html`
  <label for="name">${t.name}</label>
  <input type="text" id="name" name="name" required maxlength="200" autocomplete="name" value="${values.name ?? inv.name ?? ""}">
  <label>${t.email}</label>
  <p class="readonly">${inv.email}</p>
  <p class="help">${t.emailFixed}</p>
  ${d.guestAllowed ? html`<label class="check"><input type="checkbox" name="guest" value="1"${values.guest ? raw(" checked") : ""}> ${t.guest}</label>` : ""}
  ${formFields(d.form, t, d.locale, d.account.name, values, fieldError)}` : ""}
  <div class="actions">
    ${bookable.length ? html`<button type="submit" name="answer" value="accept">${t.accept}</button>` : ""}
    ${inv.status !== "declined" ? html`<button type="submit" name="answer" value="decline" class="secondary" formnovalidate>${t.decline}</button>` : ""}
  </div>
</form>`;
}

/** The registration's status at the top of the manage page. */
function statusBlock(reg: { status: string; cancelledBy: string | null; confirmedAt: Date | null }, position: number | null, t: Texts): Raw {
  if (reg.status === "waitlisted") {
    return html`<p><span class="status waitlisted">${t.onWaitlist}</span></p>${position ? html`<p>${t.waitlistPosition(position)}</p>` : ""}`;
  }
  if (reg.status === "offered") return html`<p><span class="status offered">${t.offered}</span></p>`;
  if (reg.status === "cancelled") {
    const text = reg.cancelledBy === "expired" ? t.offerExpired : reg.confirmedAt === null ? t.leftWaitlist : t.cancelledRegistration;
    return html`<p><span class="status cancelled">${text}</span></p>`;
  }
  return html`<p><span class="status available">${t.confirmed}</span></p>`;
}

export function registerPages(app: FastifyInstance, svc: AttendeeService, limiter: RateLimiter) {
  const limited = (req: FastifyRequest) => limiter.take(`ip:${req.ip}`) > 0;

  type InvNotice = { ok: "declined" } | { error: unknown } | null;
  const renderInvitation = async (reply: FastifyReply, token: string, locale: string | undefined, n: InvNotice, values: Form = {}, status = 200) => {
    const r = await svc.invitation(token, locale);
    if (!r) return notFound(reply, locale ?? "en", true);
    if ("accepted" in r) return reply.redirect(`/m/${r.accepted}${locale ? `?lang=${encodeURIComponent(locale)}` : ""}`, 303);
    const d = r.details;
    const t = textsFor(d.locale);
    const base = `/i/${token}`;
    const notice = !n ? (d.invitation.status === "declined" ? { text: t.declinedNotice, error: false } : null)
      : "ok" in n ? { text: t.declinedDone, error: false }
      : {
          text: n.error instanceof DomainError && n.error.code === "already_registered" ? t.errors.already_accepted
            : typeof n.error === "string" && n.error in t.errors ? t.errors[n.error as keyof Texts["errors"]] : errorText(t, n.error),
          error: true,
        };
    const body = html`
${notice ? html`<p class="notice${notice.error ? " error" : ""}" role="${notice.error ? "alert" : "status"}">${notice.text}</p>` : ""}
${d.image ? html`<img class="hero" src="${d.image.url}" alt="${d.image.alt ?? ""}">` : ""}
<p class="muted" style="margin-bottom:.25rem">${t.invitedBy(d.account.name)}</p>
<h1>${d.title}</h1>
${d.shortDescription ? html`<p class="muted">${d.shortDescription}</p>` : ""}
${d.guestAllowed ? html`<p>${t.guestInvite}</p>` : ""}
${invitationForm(d, t, base, values, n && "error" in n ? errorField(n.error) : null)}`;
    const links = d.locales.length > 1 ? d.locales.filter((l) => l !== d.locale).map((l) => ({ locale: l, href: `${base}?lang=${encodeURIComponent(l)}` })) : [];
    return send(reply, status, page({ locale: d.locale, title: d.title, account: d.account.name, langLinks: links, body }));
  };

  app.get<{ Params: { token: string }; Querystring: { declined?: string; lang?: string } }>("/i/:token", async (req, reply) =>
    renderInvitation(reply, req.params.token, req.query.lang ?? preferredLocale(req.headers["accept-language"]), req.query.declined ? { ok: "declined" } : null));

  app.post<{ Params: { token: string }; Body: Form }>("/i/:token", async (req, reply) => {
    const form = req.body ?? {};
    const token = req.params.token;
    const langQ = form.locale ? `lang=${encodeURIComponent(form.locale)}` : "";
    if (limited(req)) return renderInvitation(reply, token, form.locale, { error: "rate_limited" }, form, 429);
    try {
      if (form.answer === "decline") {
        if (!(await svc.decline(token))) return notFound(reply, form.locale ?? "en", true);
        return reply.redirect(`/i/${token}?declined=1${langQ ? `&${langQ}` : ""}`, 303);
      }
      if (!form.occurrenceId) return renderInvitation(reply, token, form.locale, { error: "not_found" }, form, 422);
      const fields = (await svc.invitationForm(token))?.fields ?? [];
      const res = await svc.accept(token, { occurrenceId: form.occurrenceId, name: form.name, locale: form.locale, partySize: form.guest ? 2 : 1, ...answerInput(fields, form) });
      if (!res) return notFound(reply, form.locale ?? "en", true);
      return reply.redirect(`/m/${res.manageToken}?welcome=1${langQ ? `&${langQ}` : ""}`, 303);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return renderInvitation(reply, token, form.locale, { error: e }, form, e.status);
    }
  });

  const renderOpen = async (reply: FastifyReply, d: Details, values: Form = {}, error: string | null = null, status = 200, fieldError: FieldError = null) => {
    const t = textsFor(d.locale);
    const id = d.target.occurrence.id;
    const now = d.now;
    const canRegister = d.target.event.accessPolicy === "open" && ["available", "few_left", "waitlist"].includes(d.availability.status);
    const body = html`
${eventBlock(d)}
${availabilityBadge(d, t)}
${d.target.event.accessPolicy !== "open" ? html`<p>${t.invitationOnly}</p>` : ""}
${canRegister || error ? registrationForm(d, t, `/r/${id}`, values, error, now, fieldError) : ""}`;
    return send(reply, status, page({ locale: d.locale, title: d.title, account: d.account.name, langLinks: langLinks(d, `/r/${id}`), body }));
  };

  app.get<{ Params: { occurrenceId: string } }>("/r/:occurrenceId", async (req, reply) => {
    const d = await svc.occurrence(req.params.occurrenceId, lang(req));
    if (!d) return notFound(reply, lang(req) ?? "en");
    return renderOpen(reply, d);
  });

  app.post<{ Params: { occurrenceId: string }; Body: Form }>("/r/:occurrenceId", async (req, reply) => {
    const form = req.body ?? {};
    const d = await svc.occurrence(req.params.occurrenceId, form.locale ?? lang(req));
    if (!d) return notFound(reply, lang(req) ?? "en");
    const t = textsFor(d.locale);
    if (limited(req)) return renderOpen(reply, d, form, t.errors.rate_limited, 429);
    const started = Number(form.t);
    if (form.website || !Number.isFinite(started) || svc.now().getTime() - started < MIN_FORM_MS) return renderOpen(reply, d, form, t.errors.bot, 400);
    try {
      const res = await svc.register(d.target.occurrence.id, { name: form.name ?? "", email: form.email ?? "", locale: d.locale, partySize: form.guest ? 2 : 1, ...answerInput(d.form.fields, form) });
      if (!res) return notFound(reply, d.locale);
      return reply.redirect(`/m/${res.manageToken}?welcome=1`, 303);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return renderOpen(reply, await svc.occurrence(d.target.occurrence.id, d.locale) ?? d, form, errorText(t, e), e.status, errorField(e));
    }
  });

  /** notice: a success message key, or an error (a DomainError or a key of the error texts). */
  type Notice = { ok: "welcome" | "saved" | "cancelled" | "claimed" } | { error: unknown } | null;
  const renderManage = async (reply: FastifyReply, token: string, locale: string | undefined, n: Notice, status = 200, posted: Form | null = null) => {
    const v = await svc.view(token, locale);
    if (!v) return notFound(reply, locale ?? "en", true);
    const d = v.details;
    const t = textsFor(d.locale);
    const notice = !n ? null
      : "ok" in n ? {
          text: n.ok === "welcome" ? (v.registration.status === "confirmed" ? t.confirmedLead : t.waitlistLead)
            : n.ok === "saved" ? t.saved : n.ok === "claimed" ? t.claimed
            : v.registration.status === "cancelled" && v.registration.confirmedAt === null ? t.leftWaitlist : t.cancelledRegistration,
          error: false,
        }
      : { text: typeof n.error === "string" && n.error in t.errors ? t.errors[n.error as keyof Texts["errors"]] : errorText(t, n.error), error: true };
    const reg = v.registration;
    const base = `/m/${token}`;
    const qr = v.admissionToken ? await QRCode.toString(v.admissionToken, { type: "svg", errorCorrectionLevel: "M", margin: 1 }) : null;
    const body = html`
${notice ? html`<p class="notice${notice.error ? " error" : ""}" role="${notice.error ? "alert" : "status"}">${notice.text}</p>` : ""}
${statusBlock(reg, v.waitlistPosition, t)}
${eventBlock(d)}
${reg.status === "offered" && v.rights.claim ? html`
<form class="card" method="post" action="${base}/claim">
  <h2 style="margin-top:0">${t.offered}</h2>
  <input type="hidden" name="locale" value="${d.locale}">
  <p>${t.offerLead(formatWhen(d.locale, d.target.event.timezone, reg.offerExpiresAt!))}</p>
  <button type="submit">${t.claim}</button>
</form>` : ""}
${d.target.occurrence.status === "cancelled" ? html`<p><span class="status cancelled">${t.cancelledOccurrence}</span></p>` : ""}
<section class="card">
  <h2 style="margin-top:0">${t.yourRegistration}</h2>
  <ul class="meta"><li>${reg.name}</li><li>${reg.email}</li><li>${t.partyOf(reg.partySize)}</li></ul>
  ${answerList(d.form, v.answers, t, d.locale)}
  ${qr ? html`<div class="qr" role="img" aria-label="${t.qrAlt}">${raw(qr)}</div>` : ""}
</section>
${reg.status !== "cancelled" ? (v.rights.change ? html`
<form class="card" method="post" action="${base}">
  <h2 style="margin-top:0">${t.changeTitle}</h2>
  <input type="hidden" name="locale" value="${d.locale}">
  <label for="name">${t.name}</label>
  <input type="text" id="name" name="name" required maxlength="200" autocomplete="name" value="${posted?.name ?? reg.name}">
  ${d.target.event.guestAllowed || reg.partySize === 2 ? html`<input type="hidden" name="guestField" value="1"><label class="check"><input type="checkbox" name="guest" value="1"${(posted ? posted.guest : reg.partySize === 2) ? raw(" checked") : ""}> ${t.guest}</label>` : ""}
  ${d.form.fields.length ? html`<input type="hidden" name="answersField" value="1">
  ${formFields(d.form, t, d.locale, d.account.name, posted ?? { ...answersToForm(d.form.fields, v.answers), ...(reg.sensitiveConsentAt ? { consent: "1" } : {}) }, n && "error" in n ? errorField(n.error) : null)}` : ""}
  <button type="submit">${t.save}</button>
</form>` : html`<p class="muted">${t.changeClosed}</p>`) : ""}
${v.rights.cancel ? html`
<form class="card" method="post" action="${base}/cancel">
  ${(() => {
    const c = reg.status === "waitlisted" ? [t.leaveWaitlist, t.leaveWaitlistHelp, t.leaveWaitlistConfirm]
      : reg.status === "offered" ? [t.declineOffer, t.declineOfferHelp, t.declineOfferConfirm]
      : [t.cancel, t.cancelHelp, t.cancelConfirm];
    return html`<h2 style="margin-top:0">${c[0]}</h2>
  <input type="hidden" name="locale" value="${d.locale}">
  <p class="muted">${c[1]}</p>
  <button type="submit" class="secondary">${c[2]}</button>`;
  })()}
</form>` : ""}`;
    return send(reply, status, page({ locale: d.locale, title: d.title, account: d.account.name, langLinks: langLinks(d, base), body }));
  };

  app.get<{ Params: { token: string }; Querystring: { welcome?: string; saved?: string; cancelled?: string; claimed?: string; lang?: string } }>("/m/:token", async (req, reply) => {
    const q = req.query;
    const n: Notice = q.welcome ? { ok: "welcome" } : q.saved ? { ok: "saved" } : q.cancelled ? { ok: "cancelled" } : q.claimed ? { ok: "claimed" } : null;
    return renderManage(reply, req.params.token, q.lang, n);
  });

  app.post<{ Params: { token: string }; Body: Form }>("/m/:token", async (req, reply) => {
    const form = req.body ?? {};
    if (limited(req)) return renderManage(reply, req.params.token, form.locale, { error: "rate_limited" }, 429);
    try {
      const fields = form.answersField ? (await svc.view(req.params.token, form.locale))?.details.form.fields ?? [] : [];
      const patch = { name: form.name, ...(form.guestField ? { partySize: form.guest ? 2 : 1 } : {}), ...(form.answersField ? answerInput(fields, form) : {}) };
      const r = await svc.update(req.params.token, patch);
      if (!r) return notFound(reply, form.locale ?? "en", true);
      return reply.redirect(`/m/${req.params.token}?saved=1${form.locale ? `&lang=${encodeURIComponent(form.locale)}` : ""}`, 303);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return renderManage(reply, req.params.token, form.locale, { error: e }, e.status, form);
    }
  });

  app.post<{ Params: { token: string }; Body: Form }>("/m/:token/claim", async (req, reply) => {
    const form = req.body ?? {};
    if (limited(req)) return renderManage(reply, req.params.token, form.locale, { error: "rate_limited" }, 429);
    try {
      const r = await svc.claim(req.params.token);
      if (!r) return notFound(reply, form.locale ?? "en", true);
      return reply.redirect(`/m/${req.params.token}?claimed=1${form.locale ? `&lang=${encodeURIComponent(form.locale)}` : ""}`, 303);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return renderManage(reply, req.params.token, form.locale, { error: e }, e.status);
    }
  });

  app.post<{ Params: { token: string }; Body: Form }>("/m/:token/cancel", async (req, reply) => {
    const form = req.body ?? {};
    if (limited(req)) return renderManage(reply, req.params.token, form.locale, { error: "rate_limited" }, 429);
    try {
      const r = await svc.cancel(req.params.token);
      if (!r) return notFound(reply, form.locale ?? "en", true);
      return reply.redirect(`/m/${req.params.token}?cancelled=1${form.locale ? `&lang=${encodeURIComponent(form.locale)}` : ""}`, 303);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return renderManage(reply, req.params.token, form.locale, { error: e }, e.status);
    }
  });
}
