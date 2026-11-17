import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { DomainError } from "@event-manager/domain";
import { html, page, raw, type Raw } from "./html.js";
import { formatWhen, type Texts, textsFor } from "./i18n.js";
import type { RateLimiter } from "./rate-limit.js";
import { type AttendeeService, type Details, preferredLocale } from "./service.js";

// Hosted attendee pages (docs/registration.md, "Attendee pages"):
//   /r/{occurrence}  open registration
//   /m/{token}       see, change or cancel a registration
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

function registrationForm(d: Details, t: Texts, action: string, values: Form, error: string | null, now: Date): Raw {
  return html`
<form class="card" method="post" action="${action}" novalidate>
  <h2 style="margin-top:0">${t.registerFor} ${d.title}</h2>
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
  <button type="submit">${t.submit}</button>
</form>`;
}

export function registerPages(app: FastifyInstance, svc: AttendeeService, limiter: RateLimiter) {
  const limited = (req: FastifyRequest) => limiter.take(`ip:${req.ip}`) > 0;

  const renderOpen = async (reply: FastifyReply, d: Details, values: Form = {}, error: string | null = null, status = 200) => {
    const t = textsFor(d.locale);
    const id = d.target.occurrence.id;
    const now = d.now;
    const canRegister = d.target.event.accessPolicy === "open" && (d.availability.status === "available" || d.availability.status === "few_left");
    const body = html`
${eventBlock(d)}
${availabilityBadge(d, t)}
${d.target.event.accessPolicy !== "open" ? html`<p>${t.invitationOnly}</p>` : ""}
${canRegister || error ? registrationForm(d, t, `/r/${id}`, values, error, now) : ""}`;
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
      const res = await svc.register(d.target.occurrence.id, { name: form.name ?? "", email: form.email ?? "", locale: d.locale, partySize: form.guest ? 2 : 1 });
      if (!res) return notFound(reply, d.locale);
      return reply.redirect(`/m/${res.manageToken}?welcome=1`, 303);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return renderOpen(reply, await svc.occurrence(d.target.occurrence.id, d.locale) ?? d, form, errorText(t, e), e.status);
    }
  });

  /** notice: a success message key, or an error (a DomainError or a key of the error texts). */
  type Notice = { ok: "welcome" | "saved" | "cancelled" } | { error: unknown } | null;
  const renderManage = async (reply: FastifyReply, token: string, locale: string | undefined, n: Notice, status = 200) => {
    const v = await svc.view(token, locale);
    if (!v) return notFound(reply, locale ?? "en", true);
    const d = v.details;
    const t = textsFor(d.locale);
    const notice = !n ? null
      : "ok" in n ? { text: n.ok === "welcome" ? t.confirmedLead : n.ok === "saved" ? t.saved : t.cancelledRegistration, error: false }
      : { text: typeof n.error === "string" && n.error in t.errors ? t.errors[n.error as keyof Texts["errors"]] : errorText(t, n.error), error: true };
    const reg = v.registration;
    const base = `/m/${token}`;
    const qr = v.admissionToken ? await QRCode.toString(v.admissionToken, { type: "svg", errorCorrectionLevel: "M", margin: 1 }) : null;
    const body = html`
${notice ? html`<p class="notice${notice.error ? " error" : ""}" role="${notice.error ? "alert" : "status"}">${notice.text}</p>` : ""}
<p><span class="status ${reg.status === "cancelled" ? "cancelled" : "available"}">${reg.status === "cancelled" ? t.cancelledRegistration : t.confirmed}</span></p>
${eventBlock(d)}
${d.target.occurrence.status === "cancelled" ? html`<p><span class="status cancelled">${t.cancelledOccurrence}</span></p>` : ""}
<section class="card">
  <h2 style="margin-top:0">${t.yourRegistration}</h2>
  <ul class="meta"><li>${reg.name}</li><li>${reg.email}</li><li>${t.partyOf(reg.partySize)}</li></ul>
  ${qr ? html`<div class="qr" role="img" aria-label="${t.qrAlt}">${raw(qr)}</div>` : ""}
</section>
${reg.status !== "cancelled" ? (v.rights.change ? html`
<form class="card" method="post" action="${base}">
  <h2 style="margin-top:0">${t.changeTitle}</h2>
  <input type="hidden" name="locale" value="${d.locale}">
  <label for="name">${t.name}</label>
  <input type="text" id="name" name="name" required maxlength="200" autocomplete="name" value="${reg.name}">
  ${d.target.event.guestAllowed || reg.partySize === 2 ? html`<input type="hidden" name="guestField" value="1"><label class="check"><input type="checkbox" name="guest" value="1"${reg.partySize === 2 ? raw(" checked") : ""}> ${t.guest}</label>` : ""}
  <button type="submit">${t.save}</button>
</form>` : html`<p class="muted">${t.changeClosed}</p>`) : ""}
${v.rights.cancel ? html`
<form class="card" method="post" action="${base}/cancel">
  <h2 style="margin-top:0">${t.cancel}</h2>
  <input type="hidden" name="locale" value="${d.locale}">
  <p class="muted">${t.cancelHelp}</p>
  <button type="submit" class="secondary">${t.cancelConfirm}</button>
</form>` : ""}`;
    return send(reply, status, page({ locale: d.locale, title: d.title, account: d.account.name, langLinks: langLinks(d, base), body }));
  };

  app.get<{ Params: { token: string }; Querystring: { welcome?: string; saved?: string; cancelled?: string; lang?: string } }>("/m/:token", async (req, reply) => {
    const q = req.query;
    const n: Notice = q.welcome ? { ok: "welcome" } : q.saved ? { ok: "saved" } : q.cancelled ? { ok: "cancelled" } : null;
    return renderManage(reply, req.params.token, q.lang, n);
  });

  app.post<{ Params: { token: string }; Body: Form }>("/m/:token", async (req, reply) => {
    const form = req.body ?? {};
    if (limited(req)) return renderManage(reply, req.params.token, form.locale, { error: "rate_limited" }, 429);
    try {
      const patch = { name: form.name, ...(form.guestField ? { partySize: form.guest ? 2 : 1 } : {}) };
      const r = await svc.update(req.params.token, patch);
      if (!r) return notFound(reply, form.locale ?? "en", true);
      return reply.redirect(`/m/${req.params.token}?saved=1${form.locale ? `&lang=${encodeURIComponent(form.locale)}` : ""}`, 303);
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
