-- Seed the promotion templates (E5).
--
-- Deliberately a MIGRATION, not an install-lifecycle step. `template` is a
-- global table with no `shop_id`: its rows are identical for every shop, so
-- seeding them is a property of the DATABASE, not of any one shop installing
-- the app. Tying it to install would also have meant already-installed shops
-- never received the catalogue at all.
--
-- `ON CONFLICT (slug) DO NOTHING` against `template_slug_unq` makes this safe
-- to re-run and safe against a partially seeded table.
--
-- Ids are fixed rather than minted so re-running is genuinely a no-op. Copy
-- changes ship as a NEW custom migration
-- (`npx drizzle-kit generate --custom`) generated from
-- `src/lib/templates/catalogue.ts`, which stays the canonical definition and
-- carries the tests that validate it.

INSERT INTO `template` (`id`, `slug`, `name`, `description`, `example`, `category`, `symbol`, `type`, `defaults`, `sort_order`, `active`, `created_at`, `updated_at`)
VALUES ('tpl-0001-pct-off', 'pct-off', 'Percentage off', 'Take a straight percentage off the products you choose.', '15% off this collection', 'Save %', '%', 'tier', '{"message":"","applyTo":"price","discountType":"percentage","productDiscountSelectionStrategy":"MAXIMUM","platform":"BOTH","tiers":[{"id":"t1","value":"","selectorType":"variant_id","targets":"[]","min_qty":""}]}', 10, 1, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')
ON CONFLICT (`slug`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `template` (`id`, `slug`, `name`, `description`, `example`, `category`, `symbol`, `type`, `defaults`, `sort_order`, `active`, `created_at`, `updated_at`)
VALUES ('tpl-0002-buy-more', 'buy-more', 'Buy more, save more', 'The more a shopper buys, the bigger the discount.', 'Buy 3, get 20% off', 'Volume', '%', 'tier', '{"message":"","applyTo":"price","discountType":"percentage","productDiscountSelectionStrategy":"MAXIMUM","platform":"BOTH","tiers":[{"id":"t1","value":"","selectorType":"variant_id","targets":"[]","min_qty":"2"},{"id":"t2","value":"","selectorType":"variant_id","targets":"[]","min_qty":"3"},{"id":"t3","value":"","selectorType":"variant_id","targets":"[]","min_qty":"5"}]}', 20, 1, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')
ON CONFLICT (`slug`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `template` (`id`, `slug`, `name`, `description`, `example`, `category`, `symbol`, `type`, `defaults`, `sort_order`, `active`, `created_at`, `updated_at`)
VALUES ('tpl-0003-clearance', 'clearance', 'Clearance / RRP markdown', 'Mark products down from their compare-at price.', 'Was $80, now $60', 'Clearance', '%', 'tier', '{"message":"","applyTo":"compare_at_price","discountType":"amount","productDiscountSelectionStrategy":"MAXIMUM","platform":"BOTH","tiers":[{"id":"t1","value":"","selectorType":"variant_id","targets":"[]","min_qty":""}]}', 30, 1, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')
ON CONFLICT (`slug`) DO NOTHING;
