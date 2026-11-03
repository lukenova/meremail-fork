-- Two-way IMAP sync state (hand-written; see packages/server/src/services/imap-sync.ts)
-- Where each email was last seen on the IMAP server
CREATE TABLE `email_imap_locations` (
	`email_id` integer PRIMARY KEY NOT NULL,
	`imap_folder` text NOT NULL,
	`uid` integer,
	`uid_validity` integer
);
--> statement-breakpoint
CREATE INDEX `idx_email_imap_locations_folder` ON `email_imap_locations` (`imap_folder`);
--> statement-breakpoint
-- The Meremail folder a thread was in when it last matched the server
CREATE TABLE `thread_imap_sync` (
	`thread_id` integer PRIMARY KEY NOT NULL,
	`synced_folder_id` integer NOT NULL
);
--> statement-breakpoint
-- Server copies of emails deleted in Meremail, waiting to be deleted on the server
CREATE TABLE `imap_pending_deletes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`imap_folder` text NOT NULL,
	`uid` integer,
	`uid_validity` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Message-IDs deleted in Meremail, so their server copies are never re-imported
CREATE TABLE `imap_forgotten` (
	`message_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- IMAP folders whose Meremail folder was deleted, waiting to be removed on the server
CREATE TABLE `imap_deleted_folders` (
	`imap_folder` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER emails_imap_ad AFTER DELETE ON `emails` BEGIN
  INSERT INTO imap_pending_deletes (message_id, imap_folder, uid, uid_validity, created_at)
    SELECT old.message_id, l.imap_folder, l.uid, l.uid_validity, CAST(strftime('%s', 'now') AS INTEGER)
    FROM email_imap_locations l WHERE l.email_id = old.id AND old.message_id IS NOT NULL;
  INSERT OR IGNORE INTO imap_forgotten (message_id, created_at)
    SELECT old.message_id, CAST(strftime('%s', 'now') AS INTEGER) WHERE old.message_id IS NOT NULL;
  DELETE FROM email_imap_locations WHERE email_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER email_threads_imap_ad AFTER DELETE ON `email_threads` BEGIN
  DELETE FROM thread_imap_sync WHERE thread_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER folders_imap_ad AFTER DELETE ON `folders` WHEN old.imap_folder IS NOT NULL AND old.is_system = 0 BEGIN
  INSERT OR IGNORE INTO imap_deleted_folders (imap_folder, created_at)
    VALUES (old.imap_folder, CAST(strftime('%s', 'now') AS INTEGER));
END;
