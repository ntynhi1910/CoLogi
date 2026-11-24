from .base import *

DEBUG = os.environ.get("DJANGO_DEBUG", "True").lower() in {"1", "true", "yes", "on"}
F1_UAT_DATABASE = os.environ.get("COLOGI_F1_UAT_DATABASE", "cologi_cp08_dev_review")
F3_UAT_HUB_COVERAGE_DATABASE = "cologi_cp08_dev_review"

# The approved F4 registry belongs to this review database. Keep it available after a plain
# runserver restart while honoring an explicit COLOGI_F4_TIME_EVIDENCE_FILE override.
if F4_TIME_EVIDENCE_FILE is None and DATABASES["default"]["NAME"] == F3_UAT_HUB_COVERAGE_DATABASE:
    F4_TIME_EVIDENCE_FILE = BASE_DIR.parent / "artifacts" / "cp08-group10.3" / "f4-uat-evidence.json"

# Group 11.2 approved this registry only for the local review database.
if F5_PRICE_EVIDENCE_FILE is None and DATABASES["default"]["NAME"] == F3_UAT_HUB_COVERAGE_DATABASE:
    approved_f5_evidence = BASE_DIR.parent / "artifacts" / "cp08-group11.2" / "f5-uat-evidence.json"
    if approved_f5_evidence.is_file():
        F5_PRICE_EVIDENCE_FILE = approved_f5_evidence
