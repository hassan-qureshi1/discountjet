ALTER TABLE `bundle` ADD `schedule_error` text;--> statement-breakpoint
CREATE INDEX `bundle_due_start_idx` ON `bundle` (`status`,`schedule_start`);--> statement-breakpoint
CREATE INDEX `bundle_due_end_idx` ON `bundle` (`status`,`schedule_end`);