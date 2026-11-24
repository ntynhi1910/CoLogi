import django.db.models.lookups
import planning.json_validators
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("planning", "0001_initial"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="planningrundemand",
            name="ck_planning_run_demands_eligibility",
        ),
        migrations.AddField(
            model_name="planningrun",
            name="failure_diagnostics",
            field=models.JSONField(
                default=list,
                validators=[planning.json_validators.validate_diagnostics_array],
            ),
        ),
        migrations.AlterField(
            model_name="planningrundemand",
            name="eligibility_status",
            field=models.CharField(
                choices=[
                    ("NOT_EVALUATED", "Not evaluated"),
                    ("ELIGIBLE", "Eligible"),
                    ("EXCLUDED", "Excluded"),
                ],
                default="NOT_EVALUATED",
                max_length=20,
            ),
        ),
        migrations.AddConstraint(
            model_name="planningrun",
            constraint=models.CheckConstraint(
                condition=django.db.models.lookups.Exact(
                    models.Func(models.F("failure_diagnostics"), function="jsonb_typeof"),
                    models.Value("array"),
                ),
                name="ck_planning_runs_failure_diag_array",
            ),
        ),
        migrations.AddConstraint(
            model_name="planningrundemand",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    eligibility_status__in=["NOT_EVALUATED", "ELIGIBLE", "EXCLUDED"]
                ),
                name="ck_planning_run_demands_eligibility",
            ),
        ),
    ]
