import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Db, withoutTenant, withTenant } from "@event-manager/db";
import { DomainError, payments } from "@event-manager/domain";
import { html, page, raw, type Raw } from "./html.js";
import { formatWhen } from "./i18n.js";
import type { RateLimiter } from "./rate-limit.js";
import { preferredLocale } from "./service.js";

// The hosted checkout's buyer pages (docs/checkout.md, "The buy flow"):
//   /b/{occurrence}       the offers at their prices, quantities and the buyer's details
//   /b/return/{token}     where Vipps sends the buyer back: receipt and tickets, a waiting
//                         page that refreshes itself, or what went wrong
//   /b/fake-vipps/{ref}   local stacks with VIPPS=fake only: approve or reject the payment
// Server-rendered, no client JavaScript and no accounts (ADR 0005). The buy form has the same
// protections as registration: a honeypot, a minimum time on the form and a per-IP rate limit.

type Form = Record<string, string | undefined>;
const MIN_FORM_MS = 1500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CheckoutPagesDeps {
  db: Db;
  provider: payments.PaymentProvider;
  attendeeUrl: string;
  limiter: RateLimiter;
  clock: () => Date;
  /** Where the buy form may be sent on to: the Vipps landing pages. Default: Vipps' and MobilePay's domains. */
  landingOrigins?: string[];
  /** The in-memory Vipps of a local stack, for its landing page. */
  fake?: { approve(reference: string): void; reject(reference: string): void; find(reference: string): { returnUrl: string; amount: { value: number; currency: string }; description: string } | undefined } | null;
}

const T = {
  en: {
    buy: "Buy tickets", quantity: "Number", total: "Total", name: "Name", email: "Email", phone: "Mobile number (optional)",
    phoneHelp: "Fills in your number in Vipps.", emailHelp: "We send the tickets and the receipt here.", pay: "Pay with Vipps",
    closed: "Tickets are not on sale here right now.", notOnSale: "Not on sale", soldOut: "Sold out", each: "each",
    vatIncluded: "VAT included", waiting: "Waiting for Vipps …", waitingHelp: "Approve the payment in the Vipps app. This page updates by itself.",
    paid: "Thank you! Your order is confirmed", paidLead: "We have sent the tickets and the receipt to your email.", receipt: "Receipt", order: "Order",
    vat: (rate: string) => `Of which VAT ${rate} %`, tickets: "Your tickets", openTicket: "Open ticket", free: "Your tickets are confirmed",
    failed: "The payment was not completed", failedLead: "No money has been taken, and the tickets have been released.",
    cancelledLead: "The tickets could not be issued, so the payment was cancelled. No money has been taken.", tryAgain: "Try again",
    refunded: {
      done: (amount: string) => `The tickets could not be issued, so the order was cancelled. ${amount} has been refunded to you through Vipps.`,
      pending: (amount: string) => `The tickets could not be issued, so the order was cancelled. We are refunding ${amount} to you through Vipps; it can take a little while.`,
      failed: (amount: string, shop: string) => `The tickets could not be issued, so the order was cancelled. ${amount} was charged and has not been refunded yet. Contact ${shop} if it has not come back within a few days.`,
    },
    orgNumber: "Org. no.", errors: {
      sold_out: "Sorry, there are not enough tickets left.", quantity_out_of_range: "Choose a number of tickets within the limits shown.",
      not_on_sale: "These tickets are not on sale right now.", offer_unavailable: "These tickets are not on sale right now.",
      validation_failed: "Check the fields and try again.", conflict: "Vipps could not start the payment. Try again.",
      rate_limited: "Too many attempts. Wait a minute and try again.", bot: "Your order could not be sent. Try again.", generic: "Something went wrong. Try again.",
    } as Record<string, string>,
  },
  nb: {
    buy: "Kjøp billetter", quantity: "Antall", total: "Totalt", name: "Navn", email: "E-post", phone: "Mobilnummer (valgfritt)",
    phoneHelp: "Fyller inn nummeret ditt i Vipps.", emailHelp: "Vi sender billettene og kvitteringen hit.", pay: "Betal med Vipps",
    closed: "Billettene selges ikke her akkurat nå.", notOnSale: "Ikke i salg", soldOut: "Utsolgt", each: "per stk.",
    vatIncluded: "Inkl. mva.", waiting: "Venter på Vipps …", waitingHelp: "Godkjenn betalingen i Vipps-appen. Siden oppdateres av seg selv.",
    paid: "Takk! Bestillingen er bekreftet", paidLead: "Vi har sendt billettene og kvitteringen til e-posten din.", receipt: "Kvittering", order: "Ordre",
    vat: (rate: string) => `Herav mva. ${rate} %`, tickets: "Billettene dine", openTicket: "Åpne billetten", free: "Billettene dine er bekreftet",
    failed: "Betalingen ble ikke fullført", failedLead: "Ingen penger er trukket, og billettene er frigitt.",
    cancelledLead: "Billettene kunne ikke utstedes, så betalingen ble kansellert. Ingen penger er trukket.", tryAgain: "Prøv igjen",
    refunded: {
      done: (amount: string) => `Billettene kunne ikke utstedes, så bestillingen ble kansellert. ${amount} er refundert til deg gjennom Vipps.`,
      pending: (amount: string) => `Billettene kunne ikke utstedes, så bestillingen ble kansellert. Vi refunderer ${amount} til deg gjennom Vipps; det kan ta litt tid.`,
      failed: (amount: string, shop: string) => `Billettene kunne ikke utstedes, så bestillingen ble kansellert. ${amount} ble trukket og er ikke refundert ennå. Ta kontakt med ${shop} hvis pengene ikke er tilbake innen noen dager.`,
    },
    orgNumber: "Org.nr.", errors: {
      sold_out: "Beklager, det er ikke nok billetter igjen.", quantity_out_of_range: "Velg et antall innenfor grensene som vises.",
      not_on_sale: "Billettene selges ikke akkurat nå.", offer_unavailable: "Billettene selges ikke akkurat nå.",
      validation_failed: "Sjekk feltene og prøv igjen.", conflict: "Vipps kunne ikke starte betalingen. Prøv igjen.",
      rate_limited: "For mange forsøk. Vent et minutt og prøv igjen.", bot: "Bestillingen kunne ikke sendes. Prøv igjen.", generic: "Noe gikk galt. Prøv igjen.",
    } as Record<string, string>,
  },
};
const textsFor = (locale: string) => (locale.startsWith("n") ? T.nb : T.en);
const money = (locale: string, amount: number, currency = "NOK") =>
  new Intl.NumberFormat(locale.startsWith("n") ? "nb-NO" : locale, { style: "currency", currency, minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
const pct = (locale: string, n: number) => new Intl.NumberFormat(locale.startsWith("n") ? "nb-NO" : locale, { maximumFractionDigits: 2 }).format(n);

function send(reply: FastifyReply, status: number, body: string) {
  return reply.status(status).type("text/html; charset=utf-8").send(body);
}
function notFound(reply: FastifyReply, locale: string) {
  const title = locale.startsWith("n") ? "Fant ikke siden" : "Page not found";
  return send(reply, 404, page({ locale, title, body: html`<h1>${title}</h1>` }));
}

export function registerCheckoutPages(app: FastifyInstance, deps: CheckoutPagesDeps) {
  const landing = (deps.landingOrigins ?? ["https://*.vipps.no", "https://*.mobilepay.dk"]).join(" ");
  const lang = (req: FastifyRequest) => (req.query as { lang?: string }).lang ?? preferredLocale(req.headers["accept-language"]);
  const tenantOf = async (occurrenceId: string) => (UUID.test(occurrenceId) ? withoutTenant(deps.db, (tx) => payments.checkoutOccurrenceTenant(tx, occurrenceId)) : null);
  const load = async (occurrenceId: string, locale: string | undefined) => {
    const tenantId = await tenantOf(occurrenceId);
    if (!tenantId) return null;
    const p = await withTenant(deps.db, { tenantId }, (tx) => payments.checkoutPage(tx, occurrenceId, locale, deps.clock()));
    return p ? { tenantId, p } : null;
  };

  const render = (reply: FastifyReply, p: payments.CheckoutPage, values: Form = {}, error: string | null = null, status = 200) => {
    const t = textsFor(p.locale);
    const o = p.occurrence;
    const where = o.location ? [o.location.venue ? `${o.location.name}, ${o.location.venue.name}` : o.location.name].join("") : null;
    const soldOut = o.availability && "status" in o.availability && o.availability.status === "sold_out";
    const selling = p.open && !soldOut && o.status !== "cancelled" && o.offers.some((x) => x.onSale);
    const base = `/b/${o.id}`;
    const body = html`
${o.event.image ? html`<img class="hero" src="${o.event.image.url}" alt="${o.event.image.alt ?? ""}">` : ""}
<h1>${o.event.title}</h1>
<ul class="meta"><li>${formatWhen(p.locale, o.timezone, new Date(o.startUtc), new Date(o.endUtc))}</li>${where ? html`<li>${where}</li>` : ""}</ul>
${o.event.shortDescription ? html`<p class="muted">${o.event.shortDescription}</p>` : ""}
${soldOut ? html`<p><span class="status full">${t.soldOut}</span></p>` : ""}
${!selling && !soldOut ? html`<p class="notice error" role="status">${t.closed}</p>` : ""}
<form class="card" method="post" action="${base}" novalidate>
  <h2 style="margin-top:0">${t.buy}</h2>
  ${error ? html`<p class="notice error" role="alert">${error}</p>` : ""}
  <input type="hidden" name="locale" value="${p.locale}">
  <input type="hidden" name="t" value="${deps.clock().getTime()}">
  <div class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  ${o.offers.map((x) => html`
  <label class="option"><span style="flex:1"><span class="when">${x.name}</span><span class="where">${money(p.locale, x.price.amount)} ${t.each}${x.onSale ? "" : html` · ${t.notOnSale}`}</span>${x.description ? html`<span class="where">${x.description}</span>` : ""}</span>
    <input type="number" name="q_${x.id}" min="0" max="${x.maxPerReservation ?? 20}" value="${values[`q_${x.id}`] ?? "0"}" aria-label="${t.quantity}: ${x.name}" style="width:4.5rem"${x.onSale && selling ? "" : raw(" disabled")}></label>`)}
  <p class="help">${t.vatIncluded}</p>
  <label for="name">${t.name}</label>
  <input type="text" id="name" name="name" required maxlength="200" autocomplete="name" value="${values.name ?? ""}">
  <label for="email">${t.email}</label>
  <input type="email" id="email" name="email" required maxlength="254" autocomplete="email" aria-describedby="email-help" value="${values.email ?? ""}">
  <p class="help" id="email-help">${t.emailHelp}</p>
  <label for="phone">${t.phone}</label>
  <input type="text" id="phone" name="phone" inputmode="tel" maxlength="20" autocomplete="tel" aria-describedby="phone-help" value="${values.phone ?? ""}">
  <p class="help" id="phone-help">${t.phoneHelp}</p>
  ${selling ? html`<button type="submit">${t.pay}</button>` : ""}
</form>`;
    const langLinks = p.locales.length > 1 ? p.locales.filter((l) => l !== p.locale).map((l) => ({ locale: l, href: `${base}?lang=${encodeURIComponent(l)}` })) : [];
    // The form posts here and is redirected to Vipps; browsers check form-action on that redirect too.
    reply.header("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self' ${landing}; frame-ancestors 'none'; base-uri 'none'`);
    return send(reply, status, page({ locale: p.locale, title: o.event.title, account: p.accountName, langLinks, body }));
  };

  app.get<{ Params: { occurrenceId: string } }>("/b/:occurrenceId", async (req, reply) => {
    const r = await load(req.params.occurrenceId, lang(req));
    if (!r) return notFound(reply, lang(req) ?? "en");
    return render(reply, r.p);
  });

  app.post<{ Params: { occurrenceId: string }; Body: Form }>("/b/:occurrenceId", async (req, reply) => {
    const form = req.body ?? {};
    const r = await load(req.params.occurrenceId, form.locale ?? lang(req));
    if (!r) return notFound(reply, lang(req) ?? "en");
    const t = textsFor(r.p.locale);
    if (deps.limiter.take(`ip:${req.ip}`) > 0) return render(reply, r.p, form, t.errors.rate_limited!, 429);
    const started = Number(form.t);
    if (form.website || !Number.isFinite(started) || deps.clock().getTime() - started < MIN_FORM_MS) return render(reply, r.p, form, t.errors.bot!, 400);
    const lines = r.p.occurrence.offers.map((o) => ({ offerId: o.id, quantity: Number(form[`q_${o.id}`] ?? 0) || 0 })).filter((l) => l.quantity > 0);
    try {
      const s = await payments.startCheckout(deps.db, r.tenantId, {
        occurrenceId: r.p.occurrence.id, lines, locale: r.p.locale, buyer: { name: form.name ?? "", email: form.email ?? "", phone: form.phone ?? null },
      }, { provider: deps.provider, attendeeUrl: deps.attendeeUrl }, deps.clock());
      if (s.kind === "free") return reply.redirect(`/b/return/${s.token}`, 303);
      return reply.redirect(s.redirectUrl, 303);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      const again = (await load(r.p.occurrence.id, r.p.locale))?.p ?? r.p;
      return render(reply, again, form, t.errors[e.code] ?? t.errors.generic!, e.status);
    }
  });

  app.get<{ Params: { token: string } }>("/b/return/:token", async (req, reply) => {
    const token = req.params.token;
    const tenantId = payments.checkoutTokenTenant(token);
    if (!tenantId) return notFound(reply, lang(req) ?? "en");
    const paymentId = await withTenant(deps.db, { tenantId }, (tx) => payments.paymentOfToken(tx, token));
    // Vipps sends the buyer back before or after its webhook: settle the payment here too.
    if (paymentId) await payments.processPayment(deps.db, tenantId, paymentId, { provider: deps.provider }, deps.clock());
    const s = await withTenant(deps.db, { tenantId }, (tx) => payments.checkoutStatus(tx, token, deps.clock()));
    if (!s) return notFound(reply, lang(req) ?? "en");
    const locale = s.reservation.locale;
    const t = textsFor(locale);
    const r = s.reservation;
    const occurrenceId = r.lines[0]?.occurrenceId;
    const base = deps.attendeeUrl.replace(/\/+$/, "");

    if (s.state === "created" || s.state === "authorized") {
      const body = html`<h1>${t.waiting}</h1><p class="muted">${t.waitingHelp}</p>`;
      return send(reply, 200, page({ locale, title: t.waiting, account: s.accountName, body, head: html`<meta http-equiv="refresh" content="3">` }));
    }
    if (s.state === "failed" || s.state === "expired" || s.state === "cancelled") {
      const amount = s.refund ? money(locale, s.refund.amount, r.total.currency) : "";
      const lead = !s.refund ? (s.state === "cancelled" ? t.cancelledLead : t.failedLead)
        : s.refund.state === "failed" ? t.refunded.failed(amount, s.accountName) : t.refunded[s.refund.state](amount);
      const body = html`<h1>${t.failed}</h1><p>${lead}</p>
${occurrenceId ? html`<p><a href="/b/${occurrenceId}">${t.tryAgain}</a></p>` : ""}`;
      return send(reply, 200, page({ locale, title: t.failed, account: s.accountName, body }));
    }
    const lines: Raw = html`<table style="width:100%;border-collapse:collapse">${r.lines.map((l) => html`
<tr><td style="padding:.25rem 0">${l.quantity} × ${l.name}</td><td style="text-align:right;white-space:nowrap">${money(locale, l.amount, l.currency)}</td></tr>`)}
<tr><td style="padding-top:.5rem;font-weight:600">${t.total}</td><td style="text-align:right;font-weight:600">${money(locale, r.total.amount, r.total.currency)}</td></tr>
${s.vat.filter((v) => v.ratePct > 0).map((v) => html`<tr><td class="muted">${t.vat(pct(locale, v.ratePct))}</td><td class="muted" style="text-align:right">${money(locale, v.amount)}</td></tr>`)}
</table>`;
    const body = html`
<p><span class="status available">${s.state === "free" ? t.free : t.paid}</span></p>
<p>${t.paidLead}</p>
<section class="card">
  <h2 style="margin-top:0">${t.tickets}</h2>
  <ul class="meta">${r.tickets.filter((x) => x.ticketToken).map((x, i) => html`<li><a href="${base}/t/${x.ticketToken}">${t.openTicket} ${i + 1}</a></li>`)}</ul>
</section>
${s.state === "captured" ? html`<section class="card">
  <h2 style="margin-top:0">${t.receipt}</h2>
  ${s.reference ? html`<p class="muted">${t.order} ${s.reference}</p>` : ""}
  ${lines}
</section>` : ""}`;
    return send(reply, 200, page({ locale, title: t.paid, account: s.accountName, body }));
  });

  if (deps.fake) {
    const fake = deps.fake;
    app.get<{ Params: { reference: string } }>("/b/fake-vipps/:reference", async (req, reply) => {
      const p = fake.find(req.params.reference);
      if (!p) return notFound(reply, "en");
      const body = html`<h1>Fake Vipps</h1><p class="muted">Local stack (VIPPS=fake). No money moves.</p>
<form class="card" method="post" action="/b/fake-vipps/${req.params.reference}">
  <p>${p.description}</p><p><strong>${money("nb", p.amount.value, p.amount.currency)}</strong></p>
  <div class="actions"><button type="submit" name="answer" value="approve">Approve</button><button type="submit" name="answer" value="reject" class="secondary">Reject</button></div>
</form>`;
      return send(reply, 200, page({ locale: "en", title: "Fake Vipps", body }));
    });
    app.post<{ Params: { reference: string }; Body: Form }>("/b/fake-vipps/:reference", async (req, reply) => {
      const p = fake.find(req.params.reference);
      if (!p) return notFound(reply, "en");
      try {
        if (req.body?.answer === "approve") fake.approve(req.params.reference);
        else fake.reject(req.params.reference);
      } catch {
        // Already answered.
      }
      return reply.redirect(p.returnUrl, 303);
    });
  }
}
