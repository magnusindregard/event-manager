import { type Kysely, sql } from "kysely";

// User groups milestone 2: group prices (docs/user-groups.md, "Price resolution").
//
// An offer can have its own price for a user group, a group override per occurrence, and price
// rule effects can target one group. For a group at an occurrence the most specific setting
// wins: group override, then a rule's group effect, then the offer's group price; with none of
// them the group pays the general effective price. The resolver materializes a group's price
// only where one of those applied, so a missing row means "the general price".
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE offers.offer_group_price (
      tenant_id uuid NOT NULL,
      offer_id  uuid NOT NULL,
      group_id  uuid NOT NULL,
      amount    int NOT NULL CHECK (amount BETWEEN 0 AND 100000000),
      PRIMARY KEY (offer_id, group_id),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, group_id) REFERENCES catalog.user_group (tenant_id, id)
    );
    CREATE INDEX offer_group_price_group ON offers.offer_group_price (group_id);
    SELECT platform.enable_tenant_rls('offers.offer_group_price');

    CREATE TABLE offers.offer_group_override (
      tenant_id     uuid NOT NULL,
      offer_id      uuid NOT NULL,
      occurrence_id uuid NOT NULL,
      group_id      uuid NOT NULL,
      amount        int NOT NULL CHECK (amount BETWEEN 0 AND 100000000),
      PRIMARY KEY (offer_id, occurrence_id, group_id),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, group_id) REFERENCES catalog.user_group (tenant_id, id)
    );
    CREATE INDEX offer_group_override_occurrence ON offers.offer_group_override (occurrence_id);
    SELECT platform.enable_tenant_rls('offers.offer_group_override');

    -- Sparse: only where the group's own settings applied. 'default' is the offer's group price.
    CREATE TABLE offers.effective_group_price (
      tenant_id      uuid NOT NULL,
      occurrence_id  uuid NOT NULL,
      offer_id       uuid NOT NULL,
      group_id       uuid NOT NULL,
      amount         int NOT NULL,
      amount_source  rules.value_source NOT NULL,
      amount_rule_id uuid,
      PRIMARY KEY (occurrence_id, offer_id, group_id),
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, group_id) REFERENCES catalog.user_group (tenant_id, id),
      CHECK ((amount_source = 'rule') = (amount_rule_id IS NOT NULL))
    );
    CREATE INDEX effective_group_price_offer ON offers.effective_group_price (offer_id);
    SELECT platform.enable_tenant_rls('offers.effective_group_price');

    -- A price effect for one user group; null: for everyone. No foreign key, like target_ref.
    ALTER TABLE rules.rule_effect ADD COLUMN target_group uuid;
    ALTER TABLE rules.rule_effect DROP CONSTRAINT rule_effect_rule_id_effect_type_target_ref_key;
    ALTER TABLE rules.rule_effect ADD CONSTRAINT rule_effect_target_key UNIQUE NULLS NOT DISTINCT (rule_id, effect_type, target_ref, target_group);

    GRANT SELECT, INSERT, UPDATE, DELETE ON offers.offer_group_price, offers.offer_group_override, offers.effective_group_price TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM rules.rule_effect WHERE target_group IS NOT NULL;
    ALTER TABLE rules.rule_effect DROP CONSTRAINT rule_effect_target_key;
    ALTER TABLE rules.rule_effect DROP COLUMN target_group;
    ALTER TABLE rules.rule_effect ADD CONSTRAINT rule_effect_rule_id_effect_type_target_ref_key UNIQUE NULLS NOT DISTINCT (rule_id, effect_type, target_ref);
    DROP TABLE offers.effective_group_price, offers.offer_group_override, offers.offer_group_price;
  `.execute(db);
}
