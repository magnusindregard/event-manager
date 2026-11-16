# 0015 – Admin UI: shadcn/ui on Tailwind, TanStack Table for grids

**Status:** Accepted · 2026-11-16 · Supersedes [0013](0013-admin-ui-library.md)

## Context

0013 picked MUI for its ready-made grid, pickers and tree. The first screens showed that Material's look is strong enough that every screen would spend effort overriding it. We have no brand yet, and want a neutral look we can brand later by changing tokens rather than components. The admin was about 640 lines when we switched, so it was cheap to switch then.

## Decision

- **shadcn/ui** (Radix primitives, Tailwind CSS v4). Components are copied into `apps/admin/src/components/ui` and we own them. The look comes from CSS variables in `src/index.css` (neutral palette, radius, font). A brand later means changing those variables.
- App-level building blocks live next to it in `src/components/` (`PageHeader`, `Field`, `Combobox`, `DataTable`). Pages use these and `ui/*`, never Radix directly.
- **Grids: TanStack Table v9** rendered with the shadcn table (`DataTable`). Its MIT features cover the MVP and phase 2: row selection, column pinning, sizing, and cell-range selection for the price grid. We build inline editing and bulk actions ourselves.
- **Date and time:** shadcn Calendar (react-day-picker, which takes a `timeZone`), a time field, and `@date-fns/tz` for zoned conversion. Range selection is built in, so the "two pickers instead of a range" workaround from 0013 goes away.
- **Tree (locations):** a headless tree (Headless Tree or react-arborist, both MIT) styled with our tokens. Chosen when the locations screen lands in milestone 2.
- **Calendar view:** FullCalendar standard (MIT), themed through its CSS variables. **Recurrence:** rrule.js. Both unchanged from 0013.
- Toasts: sonner. Icons: lucide-react. Dark mode follows the OS through the `.dark` class.
- **Licences:** MIT or equivalent permissive licences only (lucide is ISC). Still no commercial licences.

## Consequences

- We build what MUI X gave us: inline cell editing, bulk selection UI, the zoned date-time field, the tree. More work in milestone 2. In exchange, the grid and the price grid share one table engine.
- We own the component code, so shadcn upstream fixes are pulled by hand (`pnpm dlx shadcn@latest add <component>` and review the diff).
- Accessibility rests on Radix plus our own review. Keep eslint-plugin-jsx-a11y and axe in Playwright, as in the implementation plan.
- The admin bundle shrank from about 365 KB to about 194 KB gzipped.
