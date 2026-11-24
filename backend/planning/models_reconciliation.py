"""Append-only CP12 evidence and decisions scoped to one FinalPlan and execution mode."""

from django.conf import settings
from django.db import models


class ReconciliationRecord(models.Model):
    class Mode(models.TextChoices):
        COMMERCIAL = "COMMERCIAL_EXECUTION", "Commercial execution"
        SIMULATION = "SIMULATION", "Simulation"
        CAPSTONE = "CAPSTONE", "Capstone"

    class Action(models.TextChoices):
        COST_SUBMIT = "COST_SUBMIT", "Cost submitted"
        COST_APPROVE = "COST_APPROVE", "Cost approved"
        COST_RETURN = "COST_RETURN", "Cost returned"
        ISSUE_REPORT = "ISSUE_REPORT", "Issue reported"
        ISSUE_REQUEST = "ISSUE_REQUEST", "Issue evidence requested"
        ISSUE_EVIDENCE = "ISSUE_EVIDENCE", "Issue evidence submitted"
        ISSUE_RESOLVE = "ISSUE_RESOLVE", "Issue resolved"
        CLOSE = "CLOSE", "FinalPlan closed"

    plan = models.ForeignKey("planning.FinalPlan", on_delete=models.PROTECT)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    mode = models.CharField(max_length=24, choices=Mode.choices)
    action = models.CharField(max_length=20, choices=Action.choices)
    request_id = models.UUIDField()
    target = models.CharField(max_length=140, blank=True)
    reason = models.CharField(max_length=500)
    evidence = models.JSONField(default=dict)
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "logistics_reconciliation_records"
        constraints = [
            models.UniqueConstraint(fields=("actor", "request_id"), name="uq_cp12_actor_request"),
            models.CheckConstraint(condition=models.Q(mode__in=("COMMERCIAL_EXECUTION", "SIMULATION", "CAPSTONE")),
                                   name="ck_cp12_mode"),
            models.CheckConstraint(condition=models.Q(action__in=("COST_SUBMIT", "COST_APPROVE", "COST_RETURN",
                "ISSUE_REPORT", "ISSUE_REQUEST", "ISSUE_EVIDENCE", "ISSUE_RESOLVE", "CLOSE")), name="ck_cp12_action"),
            models.CheckConstraint(condition=~models.Q(reason=""), name="ck_cp12_reason"),
        ]
        indexes = [models.Index(fields=("plan", "mode", "id"), name="ix_cp12_plan_mode")]
