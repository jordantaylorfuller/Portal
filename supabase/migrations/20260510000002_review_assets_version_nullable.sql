-- The first frameio migration's CREATE TABLE IF NOT EXISTS declared
-- version TEXT (nullable), but the table pre-existed with version NOT NULL.
-- Files without a parseable v-version in the filename caused insert failures
-- during sync (728 of 767 files on the first sync-all run). Drop the
-- constraint so unmatched-version files insert with NULL.

ALTER TABLE review_assets ALTER COLUMN version DROP NOT NULL;
