CREATE TABLE `__new_exbash_task` (
	`async_id` text NOT NULL,
	`session_id` text NOT NULL,
	`workspace` text NOT NULL,
	`scope` text NOT NULL,
	`executor` text DEFAULT 'local' NOT NULL,
	`description` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`time_start` integer NOT NULL,
	`time_end` integer,
	`exit_code` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	PRIMARY KEY(`session_id`, `workspace`, `executor`, `async_id`),
	CONSTRAINT `exbash_task_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_exbash_task` (`async_id`, `session_id`, `workspace`, `scope`, `executor`, `description`, `command`, `cwd`, `time_start`, `time_end`, `exit_code`, `time_created`, `time_updated`)
SELECT `async_id`, `session_id`, `workspace`, `scope`, `executor`, `description`, `command`, `cwd`, `time_start`, `time_end`, CAST(`exit_code` AS text), `time_created`, `time_updated` FROM `exbash_task`;
--> statement-breakpoint
DROP TABLE `exbash_task`;
--> statement-breakpoint
ALTER TABLE `__new_exbash_task` RENAME TO `exbash_task`;
--> statement-breakpoint
CREATE INDEX `exbash_task_session_idx` ON `exbash_task` (`session_id`);
--> statement-breakpoint
CREATE INDEX `exbash_task_workspace_idx` ON `exbash_task` (`workspace`);
--> statement-breakpoint
CREATE INDEX `exbash_task_executor_idx` ON `exbash_task` (`executor`);
