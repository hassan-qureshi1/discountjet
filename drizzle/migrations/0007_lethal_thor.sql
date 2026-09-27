CREATE TABLE `template` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`example` text,
	`category` text NOT NULL,
	`symbol` text,
	`type` text NOT NULL,
	`defaults` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_slug_unq` ON `template` (`slug`);--> statement-breakpoint
CREATE INDEX `template_active_sort_idx` ON `template` (`active`,`sort_order`);