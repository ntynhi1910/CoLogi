"""Server-controlled evaluation context for a dedicated Capstone identity."""

from django.conf import settings
from django.core.exceptions import PermissionDenied


PROVENANCE = "SYNTHETIC/CAPSTONE"
RUN_REFERENCE_PREFIX = "CAPSTONE:"


def enabled(scenario):
    return bool(scenario and scenario in settings.COLOGI_CAPSTONE_SCENARIOS)


def actor_scenario(actor):
    scenario = getattr(actor, "capstone_scenario", "")
    if scenario and not enabled(scenario):
        raise PermissionDenied("This Capstone scenario is disabled.")
    return scenario


def run_scenario(run):
    reference = run.source_reference or ""
    if run.source_mode == "SYNTHETIC" and reference.startswith(RUN_REFERENCE_PREFIX):
        return reference.removeprefix(RUN_REFERENCE_PREFIX)
    return ""
