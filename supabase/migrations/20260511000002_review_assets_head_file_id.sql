-- Version stacks (Frame.io v4) hold multiple file versions under a single
-- stable id. Store that stack id as frameio_asset_id (stable identity) and
-- track the current latest-version file id separately. Plain-file rows set
-- frameio_head_file_id to the same value as frameio_asset_id.
--
-- See api/frameio/sync.js for population logic.

ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_head_file_id TEXT;
