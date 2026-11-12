# 0003 – PostgreSQL as the authoritative store, including holds

**Status:** Accepted · 2026-11-12

## Context

Online, POS and RSVP compete for the same capacity. A hold must reserve capacity and record the hold atomically; an earlier diagram placed holds in Redis, which would make that atomicity impossible.

## Decision

PostgreSQL is the single authoritative store for all domain data, including holds, the outbox and background jobs.

- **Capacity check** is one conditional update, no locks held between requests:

  ```sql
  UPDATE inventory.capacity_pool
     SET held = held + $n
   WHERE id = $pool
     AND sold + held + $n <= effective_capacity
  RETURNING held, sold;
  ```

  Zero rows updated means sold out. Offers drawing from several pools update all of them in one transaction, in a fixed order (by pool id) to avoid deadlocks.
- **Hold expiry:** a sweeper job releases expired holds; expiry is also checked on confirm.
- **Time:** occurrences as `timestamptz`; series, rules and time windows as local time plus IANA timezone.
- **Effective values** (capacity, prices) materialized by the occurrence-rule resolver, with source and rule id, so availability reads never evaluate rules.
- **Sensitive registration data** (allergies, free-text form answers) in a separate table, encrypted per tenant (keys in Key Vault), deleted by the retention job; aggregates kept in a stats table.
- **Scan log** partitioned by month.
- **Redis** only for the waiting room, rate limiting and short-lived caches. Losing Redis must never lose a sale.

## Consequences

- Correctness under concurrency comes from the database, not application locks.
- Very hot on-sales are protected by the waiting room in front, not by changing the store.
- Needs load testing of the conditional update under contention before the first large on-sale.
