# 0006 – Admin as a SPA on the public API; validator in React Native

**Status:** Accepted · 2026-11-12

## Admin

- React + TypeScript single-page app (Vite).
- Uses the same public API as every other client. No private admin endpoints. This keeps the API complete, which pays off for connectors, SDKs and the MCP server.
- Components chosen early for the hard parts:
  - Recurrence editor: rrule.js, Outlook-style add/edit/exclude per occurrence.
  - Price grid (offers × occurrences) showing price source (default / rule / override): AG Grid or TanStack Table.
  - Occurrence filter shared by bulk edit and the rule editor, with match preview and conflict warnings.
- Norwegian and English from day one.
- Accessibility to WCAG 2.1 AA.

## Validator

- React Native with Expo, not a PWA: reliable camera access, local storage for the offline queue, background sync on iOS.
- Enrollment via setup QR (see 0005); the device only knows its checkpoint profile.
- Offline: verify QR signatures locally, queue redemptions, sync and flag conflicts.
- Shares domain types and API client with the admin.

## Consequences

- Two apps, one shared type and client package.
- App store distribution for the validator; consider MDM/enterprise distribution for clients that require it.
