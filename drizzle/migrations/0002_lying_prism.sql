CREATE TABLE `bundle` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`name` text NOT NULL,
	`operation` text NOT NULL,
	`items` text NOT NULL,
	`parent_variant_id` text,
	`price` integer,
	`sum_of_items` integer,
	`metafield_state` text DEFAULT 'NotYet' NOT NULL,
	`metafield_gid` text,
	`schedule_start` text,
	`schedule_end` text,
	`status` text NOT NULL,
	`block_on_failure` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shopify_shop`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bundle_shop_id_idx` ON `bundle` (`shop_id`);--> statement-breakpoint
CREATE TABLE `discount` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`shopify_gid` text NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`method` text,
	`status` text,
	`products` integer DEFAULT 0 NOT NULL,
	`campaign_id` text,
	`deleted_at` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`shop_id`) REFERENCES `shopify_shop`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discount_shop_gid_unq` ON `discount` (`shop_id`,`shopify_gid`);--> statement-breakpoint
CREATE TABLE `webhook_event` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`shop_id` text,
	`shopify_gid` text,
	`received_at` text NOT NULL
);
