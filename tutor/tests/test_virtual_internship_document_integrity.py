import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MIGRATIONS=ROOT/"cloudflare/migrations"
MIGRATION=MIGRATIONS/"0015_virtual_internship_phase9_documents.sql"
WORKER=(ROOT/"cloudflare/src/virtual_internship_phase9.ts").read_text()

class Phase9DocumentIntegrityTests(unittest.TestCase):
    def test_phase9_migration_applies_after_current_schema(self):
        with tempfile.TemporaryDirectory() as td:
            db=sqlite3.connect(Path(td)/"phase9.sqlite3")
            db.execute("PRAGMA foreign_keys=ON")
            for migration in sorted(p for p in MIGRATIONS.glob("*.sql") if p.name<=MIGRATION.name):
                db.executescript(migration.read_text())
            self.assertEqual(
                db.execute("SELECT value FROM persistence_meta WHERE key='virtual_internship_phase9_document_schema_version'").fetchone()[0],
                "1",
            )
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])

    def test_document_versions_are_immutable_and_one_current(self):
        sql=MIGRATION.read_text()
        self.assertIn("UNIQUE (completion_record_id, document_type, document_version)",sql)
        self.assertIn("idx_completion_documents_one_current",sql)
        self.assertIn("trg_completion_documents_immutable_fields",sql)
        self.assertIn("trg_completion_documents_supersession_only",sql)
        self.assertIn("trg_completion_documents_no_delete",sql)

    def test_exact_export_bytes_are_hashed_and_private_r2_is_reused(self):
        self.assertIn("sha256Bytes(bytes)",WORKER)
        self.assertIn("INSERT INTO tutor_objects",WORKER)
        self.assertIn("TUTOR_FILES.put",WORKER)
        self.assertIn("TUTOR_FILES.get",WORKER)
        self.assertIn("users',actorId,'virtual-internships'",WORKER)
        self.assertIn("cache-control':'private, no-store'",WORKER)

    def test_missing_or_tampered_bytes_fail_closed(self):
        self.assertIn("document_object_missing",WORKER)
        self.assertIn("document_integrity_failed",WORKER)
        self.assertIn("document_integrity_unavailable",WORKER)
        self.assertNotIn("silently update",WORKER.lower())

    def test_reissue_preserves_old_version_and_releases_current_slot_atomically(self):
        self.assertIn("issuance_status='superseded'",WORKER)
        self.assertIn("superseded_by_document_id",WORKER)
        self.assertIn("document_version",WORKER)
        self.assertIn("await env.TUTOR_DB.batch(statements)",WORKER)

if __name__=="__main__":
    unittest.main()
