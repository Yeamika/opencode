CREATE TABLE `exbash_task` (
	`async_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`workspace` text NOT NULL,
	`scope` text NOT NULL,
	`description` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`timeout` integer,
	`time_start` integer NOT NULL,
	`time_end` integer,
	`exit_code` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `exbash_task_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `exbash_task_session_idx` ON `exbash_task` (`session_id`);
--> statement-breakpoint
CREATE INDEX `exbash_task_workspace_idx` ON `exbash_task` (`workspace`);
