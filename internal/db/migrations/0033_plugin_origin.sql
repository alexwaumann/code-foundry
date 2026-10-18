-- Install identity (internal/store/plugin/origin.go, docs/notes/plugins-8-secrets-hardening.md).
--
-- origin: the source a plugin's consent, secrets and data belong to: "registry:<url>",
-- "github:<owner/repo>" (lower case), "path:<folder>" (a dev link) or
-- "manual:<package dir>" (put in plugins/ by hand, then enabled); '' = not known. A
-- package of the same name from another source does not inherit them: install, link and
-- dev refuse it without --force, which deletes them first. Existing rows take their dev
-- link's folder, else their install record's source.
ALTER TABLE plugins ADD COLUMN origin TEXT NOT NULL DEFAULT '';
UPDATE plugins SET origin = 'path:' || dev_path WHERE dev_path != '';
UPDATE plugins SET origin = (
    SELECT CASE i.kind WHEN 'github' THEN 'github:' || lower(i.source) ELSE i.kind || ':' || i.source END
    FROM plugin_installs i WHERE i.name = plugins.name)
WHERE origin = '' AND name IN (SELECT name FROM plugin_installs);
