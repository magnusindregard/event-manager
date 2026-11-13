# 0013 – Admin UI: MUI with MUI X Community (no commercial licences)

**Status:** Accepted · 2026-11-13 · Settles open question 6 in [docs/mvp.md](../mvp.md) and the grid choice in [0006](0006-admin-and-validator-apps.md)

## Considered

MUI + MUI X, Ant Design, Mantine, Chakra UI v3, shadcn/ui, compared against the MVP's must-haves: data grid with inline editing and bulk selection, timezone-aware date/time pickers, calendar view, tree view, forms, nb localization, WCAG 2.1 AA.

shadcn/ui and Chakra would have us assemble the grid, the tree and timezone-aware pickers ourselves. Mantine lacks a grid, and v8 dropped built-in timezone handling. Ant Design covers much, but its look is hard to theme away from and its timezone support goes through dayjs plugins.

## Decision

- **MUI core + MUI X Community (MIT only)** for the admin. No commercial licences in the MVP.
- MIT features cover the MVP: Data Grid with editing, checkbox multi-select, server-side pagination and sorting; Date/Time/DateTime pickers with `timezone`; RichTreeView; `nbNO` locale packs.
- **FullCalendar** (standard, MIT) for the calendar view. **rrule.js** for the recurrence editor (0006).
- Workarounds for Pro-only features: two pickers instead of DateRangePicker; the custom occurrence filter instead of grid multi-filters; "load more" instead of infinite scroll.

## Revisit

The phase-2 price grid (offers × occurrences) wants column pinning and range copy/paste, which are MUI X Pro/Premium features. At that point, choose between a licence and a free grid (AG Grid Community or TanStack Table) for that one view.
