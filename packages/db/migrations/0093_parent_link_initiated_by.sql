-- Who initiated a parent/child supervision link: 'parent' (legacy — parent
-- requests, child accepts) or 'child' (child invites a parent by email, parent
-- accepts). Default 'parent' keeps every existing row valid (they were all
-- parent-initiated). The accept paths filter on this so each direction only
-- accepts its own pending requests.
ALTER TABLE "parent_child_links" ADD COLUMN "initiated_by" text NOT NULL DEFAULT 'parent';
