# 0004 – Shared database with row-level security

**Status:** Accepted · 2026-11-12

## Context

This is a product, not a per-client build. Tenants range from small venues to large museums, and data includes special-category personal data.

## Decision

- One shared database. Every tenant-owned table has `tenant_id`.
- Postgres row-level security (RLS) on every tenant-owned table. The application sets `app.tenant_id` per transaction; policies filter on it. A missing `WHERE` clause cannot leak another tenant's data.
- The application connects with a role that cannot bypass RLS. Migrations and cross-tenant jobs use a separate, audited role.
- Per-tenant encryption keys for sensitive columns.
- The data access layer is written so a tenant can be moved to a dedicated database without code changes (connection chosen per tenant).

## Consequences

- Low operational cost per tenant; one migration run for all.
- Tests must cover RLS policies explicitly (a test per table that a second tenant sees nothing).
- Noisy-neighbour risk during big on-sales is handled by the waiting room and, if needed, moving that tenant to its own database.
