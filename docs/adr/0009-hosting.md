# 0009 – Azure, Norway East

**Status:** Accepted · 2026-11-13 (proposed 2026-11-12; IaC settled in [0014](0014-infrastructure-as-code.md))

## Context

Data includes special-category personal data (dietary/allergy information). Clients include publicly funded institutions that are already on Microsoft 365 and Azure.

## Proposal

- Region: Azure Norway East; backups geo-redundant within Norway or the EU.
- Compute: Azure Container Apps for core API, validation API, public API, worker and MCP server (separately scaled apps from one image set).
- Database: Azure Database for PostgreSQL – Flexible Server, zone-redundant HA.
- Cache: Azure Cache for Redis.
- Edge: Azure Front Door (CDN, WAF, routing per surface).
- Secrets and tenant keys: Azure Key Vault.
- Observability: OpenTelemetry → Azure Monitor / Application Insights.
- Infrastructure as code: Bicep (see 0014).

## Consequences

- Nothing in the application should depend on Azure-only APIs beyond these managed services, so the product stays portable if a client requires another cloud.
- Data processing agreements and residency statements per tenant are simpler with a single region.
