ALTER TABLE "teams" ADD COLUMN "entry_interface" VARCHAR(6);

ALTER TABLE "teams" ADD CONSTRAINT "teams_entry_interface_check"
  CHECK ("entry_interface" IN ('family', 'work'));
