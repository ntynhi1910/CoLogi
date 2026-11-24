"""Local CP08 deployment settings with Capstone isolated from the UAT registries."""

import os

from .prod import *


F4_TIME_EVIDENCE_FILE = None
F5_PRICE_EVIDENCE_FILE = None
COLOGI_REQUIRE_OPERATIONAL_DEMAND_PROVENANCE = True
COLOGI_F1_MVCC_CONFIGURATION_PIN = True
COLOGI_INTERNAL_SUPPLEMENT = True
COLOGI_MANAGER_ACCEPTANCE_PREVIEW = True
COLOGI_LEGACY_ROLE_WRITES = False
COLOGI_ACCOUNT_ADMIN_WRITES = os.environ.get("COLOGI_CP08_MAINTENANCE") != "1"
COLOGI_OUTLET_WORKSPACE_WRITES = (
    os.environ.get("COLOGI_OUTLET_WORKSPACE_WRITES") == "1"
    and os.environ.get("COLOGI_CP08_MAINTENANCE") != "1"
)
if os.environ.get("COLOGI_CP08_MAINTENANCE") == "1":
    COLOGI_CAPSTONE_SCENARIOS = frozenset()
    COLOGI_INTERNAL_SUPPLEMENT = False
    COLOGI_MANAGER_ACCEPTANCE_PREVIEW = False
if DATABASES["default"]["NAME"] != "cologi" or DATABASES["default"]["USER"] != "cologi_cp08_runtime":
    raise RuntimeError("Use the dedicated CP08 service role on cologi.")
