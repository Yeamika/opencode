CREATE TABLE `session_file_read` (
	`session_id` text NOT NULL,
	`file_key_ref` text NOT NULL,
	`filename` text NOT NULL,
	`file_path` text NOT NULL,
	`hash_code` text NOT NULL,
	`small_hash_code` text NOT NULL,
	`read_time` integer NOT NULL,
	PRIMARY KEY(`session_id`, `file_key_ref`),
	CONSTRAINT `session_file_read_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_file_read_lookup_idx` ON `session_file_read` (`session_id`,`filename`,`small_hash_code`);
--> statement-breakpoint
CREATE INDEX `session_file_read_lru_idx` ON `session_file_read` (`session_id`,`read_time`);
