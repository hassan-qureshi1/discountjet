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
CREATE INDEX `bundle_shop_id_idx` ON `bundle` (`shop_id`);
