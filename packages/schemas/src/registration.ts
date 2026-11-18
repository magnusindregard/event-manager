import { Type } from "typebox";

// Staff view of registrations (/v1, docs/registration.md "Admin interface").

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

// ── Forms (milestone 4) ──

export const Localized = Type.Record(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" }), Type.String(), { description: "Text per locale" });
export const FieldType = Type.Union([Type.Literal("text"), Type.Literal("dietary"), Type.Literal("checkbox"), Type.Literal("choice")], {
  description: "dietary: free text, always sensitive. text: one line or multiline, optionally sensitive. checkbox: e.g. consent to photos. choice: one or several options",
});
const FieldId = Type.String({ pattern: "^[a-z0-9]{1,40}$" });

export const FormField = Type.Object({
  id: FieldId,
  type: FieldType,
  label: Localized,
  help: Localized,
  required: Type.Boolean(),
  sensitive: Type.Boolean({ description: "Stored encrypted, shown only with registrations.sensitive, deleted soon after the occurrence" }),
  multiline: Type.Boolean(),
  multiple: Type.Boolean(),
  options: Type.Array(Type.Object({ id: FieldId, label: Localized })),
});

export const AnswerField = Type.Intersect([FormField, Type.Object({ retired: Type.Boolean({ description: "Removed from the form; kept so earlier answers stay readable" }) })]);

export const FormFieldInput = Type.Object(
  {
    id: Type.Optional(FieldId),
    type: FieldType,
    label: Localized,
    help: Type.Optional(Localized),
    required: Type.Optional(Type.Boolean()),
    sensitive: Type.Optional(Type.Boolean({ description: "text only; dietary is always sensitive" })),
    multiline: Type.Optional(Type.Boolean()),
    multiple: Type.Optional(Type.Boolean()),
    options: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(FieldId), label: Localized }, { additionalProperties: false }), { maxItems: 50 })),
  },
  { additionalProperties: false },
);

export const Form = Type.Object({
  eventId: Uuid,
  version: Type.Integer({ minimum: 0, description: "0: no form saved yet" }),
  fields: Type.Array(FormField),
});

export const FormSave = Type.Object(
  {
    version: Type.Integer({ minimum: 0, description: "The version the editor started from; 412 if the form has changed since" }),
    fields: Type.Array(FormFieldInput, { maxItems: 30 }),
  },
  { additionalProperties: false },
);

export const AnswerValue = Type.Union([Type.String(), Type.Boolean(), Type.Array(Type.String())]);
export const Answers = Type.Record(FieldId, AnswerValue, { description: "By field id: text, true for a ticked checkbox, option ids for a choice" });
const AnswersInput = Type.Record(Type.String(), AnswerValue, { description: "By field id. Replaces all answers" });
const Consent = Type.Boolean({ description: "Agreement to sensitive answers being stored; required when any is given" });

export const RegistrationStatus = Type.Union([Type.Literal("confirmed"), Type.Literal("waitlisted"), Type.Literal("offered"), Type.Literal("cancelled")]);

export const Registration = Type.Object({
  id: Uuid,
  eventId: Uuid,
  occurrenceId: Uuid,
  name: Type.String({ description: "Empty once anonymised (see anonymisedAt)" }),
  email: Type.String({ description: "Empty once anonymised (see anonymisedAt)" }),
  locale: Type.String(),
  partySize: Type.Integer({ minimum: 1, maximum: 2 }),
  status: RegistrationStatus,
  source: Type.Union([Type.Literal("invitation"), Type.Literal("open"), Type.Literal("staff")]),
  cancelledAt: Nullable(DateTime),
  cancelledBy: Nullable(Type.Union([Type.Literal("attendee"), Type.Literal("staff")])),
  answers: Answers,
  hiddenSensitiveAnswers: Type.Boolean({ description: "Sensitive answers exist that the caller may not see" }),
  sensitiveConsentAt: Nullable(DateTime),
  anonymisedAt: Nullable(DateTime),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});

export const RegistrationCreate = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.String({ minLength: 3, maxLength: 254 }),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$", description: "Defaults to the account's default locale" })),
    partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, description: "Staff may add a guest even where the event does not offer one" })),
    answers: Type.Optional(AnswersInput),
    consent: Type.Optional(Consent),
  },
  { additionalProperties: false },
);

export const RegistrationPatch = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" })),
    partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
    answers: Type.Optional(AnswersInput),
    consent: Type.Optional(Consent),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const RegistrationList = Type.Object({
  items: Type.Array(Registration),
  fields: Type.Array(AnswerField, { description: "The fields to show answers under; sensitive ones only with registrations.sensitive" }),
});

export const DoorList = Type.Object({
  occurrenceId: Uuid,
  eventId: Uuid,
  columns: Type.Array(Type.Object({ fieldId: Type.String(), label: Type.String(), sensitive: Type.Boolean() })),
  entries: Type.Array(Type.Object({
    registrationId: Uuid,
    name: Type.String(),
    email: Type.String(),
    partySize: Type.Integer(),
    source: Type.Union([Type.Literal("invitation"), Type.Literal("open"), Type.Literal("staff")]),
    answers: Type.Record(Type.String(), Type.String(), { description: "Answers as text by field id" }),
  }), { description: "Confirmed registrations in name order" }),
  totals: Type.Object({ registrations: Type.Integer(), people: Type.Integer() }),
});
