-- No item data is migrated. Legacy `bundle.items` JSON has no `name` field and
-- `bundle_item.name` is NOT NULL, so there is nothing valid to insert, and SQL
-- cannot call the Admin API to fetch one. Existing bundles keep their name,
-- price, status and metafield state, and have no components until the merchant
-- re-picks them. See docs/superpowers/specs/2026-09-21-bundle-item-normalization-design.md §7.
CREATE TABLE `bundle_item` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`name` text NOT NULL,
	`qty` integer NOT NULL,
	`price` integer NOT NULL,
	`price_adjustment` integer,
	`title_override` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shopify_shop`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundle`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bundle_item_bundle_id_idx` ON `bundle_item` (`bundle_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_item_bundle_variant_unq` ON `bundle_item` (`bundle_id`,`variant_id`);--> statement-breakpoint
ALTER TABLE `bundle` DROP COLUMN `items`;--> statement-breakpoint
ALTER TABLE `bundle` DROP COLUMN `sum_of_items`;