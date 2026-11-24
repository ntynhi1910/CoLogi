import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('masterdata', '0005_hub_vehicletype_vehiclecargocompatibility'),
        ('planning', '0002_group4_run_orchestration'),
    ]

    operations = [
        migrations.AlterModelOptions(
            name='planningbusinessrule',
            options={'base_manager_name': 'objects'},
        ),
        migrations.AlterModelOptions(
            name='planningruleset',
            options={'base_manager_name': 'objects'},
        ),
        migrations.CreateModel(
            name='FulfillmentPlan',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('plan_code', models.CharField(max_length=40, unique=True)),
                ('template_type', models.CharField(choices=[('DIRECT_CONSOLIDATED', 'Direct consolidated'), ('HUB_BASED', 'Hub based')], max_length=30)),
                ('status', models.CharField(choices=[('DRAFT', 'Draft'), ('VALIDATING', 'Validating'), ('PENDING_APPROVAL', 'Pending approval'), ('APPROVED', 'Approved'), ('REJECTED', 'Rejected'), ('FINALIZED', 'Finalized')], default='DRAFT', max_length=25)),
                ('recommendation_reason', models.JSONField(blank=True, null=True)),
                ('override_reason', models.TextField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('created_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
                ('group', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='plans', to='planning.collaborationgroup')),
                ('hub', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, to='masterdata.hub')),
                ('supersedes_plan', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='revisions', to='planning.fulfillmentplan')),
            ],
            options={
                'db_table': 'fulfillment_plans',
                'base_manager_name': 'objects',
            },
        ),
        migrations.CreateModel(
            name='DeliveryWave',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('wave_no', models.PositiveIntegerField()),
                ('planned_date', models.DateField()),
                ('start_time', models.TimeField(blank=True, null=True)),
                ('end_time', models.TimeField(blank=True, null=True)),
                ('total_load_kg', models.DecimalField(decimal_places=3, max_digits=12)),
                ('utilization_pct', models.DecimalField(blank=True, decimal_places=2, max_digits=5, null=True)),
                ('vehicle_type', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='masterdata.vehicletype')),
                ('plan', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.PROTECT, related_name='waves', to='planning.fulfillmentplan')),
            ],
            options={
                'db_table': 'delivery_waves',
                'base_manager_name': 'objects',
            },
        ),
        migrations.CreateModel(
            name='WaveDemand',
            fields=[
                ('pk', models.CompositePrimaryKey('wave_id', 'demand_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('allocated_quantity_kg', models.DecimalField(decimal_places=3, max_digits=12)),
                ('demand', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='wave_allocations', to='demands.deliverydemand')),
                ('wave', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.PROTECT, related_name='allocations', to='planning.deliverywave')),
            ],
            options={
                'db_table': 'wave_demands',
                'base_manager_name': 'objects',
            },
        ),
        migrations.AddIndex(
            model_name='fulfillmentplan',
            index=models.Index(fields=['status'], name='ix_fulfillment_plans_status'),
        ),
        migrations.AddConstraint(
            model_name='fulfillmentplan',
            constraint=models.CheckConstraint(condition=models.Q(('status__in', ['DRAFT', 'VALIDATING', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FINALIZED'])), name='ck_fulfillment_plan_status'),
        ),
        migrations.AddConstraint(
            model_name='fulfillmentplan',
            constraint=models.CheckConstraint(condition=models.Q(('template_type__in', ['DIRECT_CONSOLIDATED', 'HUB_BASED'])), name='ck_fulfillment_plan_template'),
        ),
        migrations.AddConstraint(
            model_name='fulfillmentplan',
            constraint=models.CheckConstraint(condition=models.Q(('supersedes_plan_id', models.F('id')), _negated=True), name='ck_fulfillment_plan_not_self'),
        ),
        migrations.AddConstraint(
            model_name='deliverywave',
            constraint=models.UniqueConstraint(fields=('plan', 'wave_no'), name='uq_delivery_wave_plan_number'),
        ),
        migrations.AddConstraint(
            model_name='deliverywave',
            constraint=models.CheckConstraint(condition=models.Q(('wave_no__gt', 0)), name='ck_delivery_wave_number'),
        ),
        migrations.AddConstraint(
            model_name='deliverywave',
            constraint=models.CheckConstraint(condition=models.Q(('total_load_kg__gte', 0)), name='ck_delivery_wave_load'),
        ),
        migrations.AddConstraint(
            model_name='deliverywave',
            constraint=models.CheckConstraint(condition=models.Q(('utilization_pct__isnull', True), models.Q(('utilization_pct__gte', 0), ('utilization_pct__lte', 100)), _connector='OR'), name='ck_delivery_wave_utilization'),
        ),
        migrations.AddConstraint(
            model_name='wavedemand',
            constraint=models.CheckConstraint(condition=models.Q(('allocated_quantity_kg__gt', 0)), name='ck_wave_demand_quantity'),
        ),
    ]
