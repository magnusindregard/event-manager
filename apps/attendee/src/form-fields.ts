import { DomainError, type registration } from "@event-manager/domain";
import { html, raw, type Raw } from "./html.js";
import type { Texts } from "./i18n.js";
import type { FormDetails } from "./service.js";

// The event's form fields on the hosted pages (docs/registration.md, "Form fields"). Plain
// HTML form posts, so every value is one string: text answers in a_{field}, a ticked checkbox
// as a_{field}=1, a single choice as a_{field}={option}, a multiple choice as
// a_{field}__{option}=1. Consent to sensitive answers is a checkbox of its own.

export type FormValues = Record<string, string | undefined>;

/** Picks the text in the page's locale, falling back to any. */
const pick = (l: registration.Localized, locale: string) => l[locale] ?? Object.values(l)[0] ?? "";

/** Reads the answers from a posted form. */
export function answersFromForm(fields: readonly registration.FormField[], form: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = `a_${f.id}`;
    if (f.type === "choice" && f.multiple) out[f.id] = f.options.filter((o) => form[`${key}__${o.id}`]).map((o) => o.id);
    else if (f.type === "checkbox") out[f.id] = form[key] === "1";
    else if (form[key] !== undefined) out[f.id] = form[key];
  }
  return out;
}

/** Stored answers as form values, to fill in the change form. */
export function answersToForm(fields: readonly registration.FormField[], answers: registration.Answers): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = answers[f.id];
    if (v === undefined) continue;
    const key = `a_${f.id}`;
    if (f.type === "choice" && Array.isArray(v)) {
      if (f.multiple) for (const id of v) out[`${key}__${id}`] = "1";
      else out[key] = v[0];
    } else if (v === true) out[key] = "1";
    else if (typeof v === "string") out[key] = v;
  }
  return out;
}

/** The field a validation error points at (a field id or "consent"), and whether it was left empty. */
export type FieldError = { field: string; required: boolean } | null;

export function errorField(e: unknown): FieldError {
  if (!(e instanceof DomainError) || e.code !== "validation_failed") return null;
  const f = String(e.details?.field ?? "");
  const field = f === "consent" ? "consent" : f.startsWith("answers.") ? f.slice(8) : null;
  return field ? { field, required: /required/i.test(e.message) } : null;
}

export const hasSensitive = (form: FormDetails) => form.fields.some((f) => f.sensitive);

/** The fields, then the consent line when any field is sensitive. */
export function formFields(form: FormDetails, t: Texts, locale: string, account: string, values: FormValues, error: FieldError): Raw {
  const fields = form.fields.map((f) => {
    const key = `a_${f.id}`;
    const invalid = error?.field === f.id;
    const label = html`${pick(f.label, locale)}${f.required || f.type === "checkbox" ? "" : html` <span class="opt">${t.optional}</span>`}`;
    const helpText = [pick(f.help, locale), f.sensitive ? t.sensitiveHint : ""].filter(Boolean).join(" ");
    const describedBy = [helpText ? `${key}-help` : "", invalid ? `${key}-error` : ""].filter(Boolean).join(" ");
    const aria = raw(`${describedBy ? ` aria-describedby="${describedBy}"` : ""}${invalid ? ' aria-invalid="true"' : ""}${f.required ? " required" : ""}`);
    const help = helpText ? html`<p class="help" id="${key}-help">${helpText}</p>` : "";
    const err = invalid ? html`<p class="field-error" id="${key}-error">${error!.required ? t.fieldRequired : t.fieldInvalid}</p>` : "";
    if (f.type === "text" || f.type === "dietary") {
      const control = f.multiline
        ? html`<textarea id="${key}" name="${key}" maxlength="2000"${aria}>${values[key] ?? ""}</textarea>`
        : html`<input type="text" id="${key}" name="${key}" maxlength="300" value="${values[key] ?? ""}"${aria}>`;
      return html`<label for="${key}">${label}</label>${control}${help}${err}`;
    }
    if (f.type === "checkbox") {
      return html`<label class="check"><input type="checkbox" name="${key}" value="1"${values[key] ? raw(" checked") : ""}${aria}> ${pick(f.label, locale)}</label>${help}${err}`;
    }
    const options = f.options.map((o) => {
      const name = f.multiple ? `${key}__${o.id}` : key;
      const checked = f.multiple ? !!values[name] : values[key] === o.id;
      return html`<label class="check"><input type="${f.multiple ? "checkbox" : "radio"}" name="${name}" value="${f.multiple ? "1" : o.id}"${checked ? raw(" checked") : ""}> ${pick(o.label, locale)}</label>`;
    });
    return html`<fieldset${invalid ? raw(' aria-invalid="true"') : ""}${describedBy ? raw(` aria-describedby="${describedBy}"`) : ""}><legend>${label}</legend>${options}${help}${err}</fieldset>`;
  });
  const consent = hasSensitive(form)
    ? html`<div class="consent"><label class="check"><input type="checkbox" name="consent" value="1"${values.consent ? raw(" checked") : ""}${error?.field === "consent" ? raw(' aria-invalid="true" aria-describedby="consent-error"') : ""}> <span>${t.consent(account, form.sensitiveDeleteAfterDays)}</span></label>
      ${error?.field === "consent" ? html`<p class="field-error" id="consent-error">${t.consentNeeded}</p>` : ""}</div>`
    : "";
  return html`${fields}${consent}`;
}

/** The attendee's answers as a definition list, for the manage page. */
export function answerList(form: FormDetails, answers: registration.Answers, t: Texts, locale: string): Raw {
  const rows = form.fields.filter((f) => answers[f.id] !== undefined).map((f) => {
    const v = answers[f.id]!;
    const text = f.type === "checkbox" ? t.yes
      : Array.isArray(v) ? v.map((id) => f.options.find((o) => o.id === id)).filter(Boolean).map((o) => pick(o!.label, locale)).join(", ")
      : String(v);
    return html`<dt>${pick(f.label, locale)}</dt><dd>${text}</dd>`;
  });
  return rows.length ? html`<h3 style="margin:1rem 0 .5rem;font-size:1rem">${t.yourAnswers}</h3><dl class="answers">${rows}</dl>` : html``;
}
