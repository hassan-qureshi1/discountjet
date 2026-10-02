CREATE TABLE `campaign` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`schedule_mode` text NOT NULL,
	`starts_at` text,
	`ends_at` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shopify_shop`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_shop_status_idx` ON `campaign` (`shop_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaign_bundle` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`bundle_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shopify_shop`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundle`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_bundle_unq` ON `campaign_bundle` (`campaign_id`,`bundle_id`);--> statement-breakpoint
CREATE TABLE `campaign_discount` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`method` text NOT NULL,
	`code` text,
	`config_json` text NOT NULL,
	`config_bytes` integer NOT NULL,
	`shopify_gid` text,
	`publish_state` text NOT NULL,
	`publish_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shopify_shop`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_discount_campaign_idx` ON `campaign_discount` (`campaign_id`);--> statement-breakpoint
ALTER TABLE `bundle` ADD `campaign_id` text REFERENCES campaign(id) ON DELETE SET NULL;