# T? ?i?n d? li?u PostgreSQL

Sinh t? schema c?a b?n c?i c? l?p. Ki?u d? li?u v? quan h? l?y tr?c ti?p t? PostgreSQL.

## audit_logs

`id` int8, `action` varchar, `entity_type` varchar, `entity_id` varchar (nullable), `old_values` jsonb (nullable), `new_values` jsonb (nullable), `ip_address` inet (nullable), `created_at` timestamptz, `actor_user_id` int8 (nullable)

- `FOREIGN KEY (actor_user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## auth_group

`id` int4, `name` varchar

- `PRIMARY KEY (id)`

## auth_group_permissions

`id` int8, `group_id` int4, `permission_id` int4

- `FOREIGN KEY (group_id) REFERENCES auth_group(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (permission_id) REFERENCES auth_permission(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## auth_permission

`id` int4, `name` varchar, `content_type_id` int4, `codename` varchar

- `FOREIGN KEY (content_type_id) REFERENCES django_content_type(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## authtoken_token

`key` varchar, `created` timestamptz, `user_id` int8

- `FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (key)`

## business_rules

`id` int8, `rule_code` varchar, `module_code` varchar, `rule_name` varchar, `description` text (nullable), `rule_definition` jsonb, `priority` int4, `is_active` bool, `rule_set_id` int8

- `FOREIGN KEY (rule_set_id) REFERENCES rule_sets(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## cargo_categories

`id` int8, `category_code` varchar, `category_name` varchar, `description` text (nullable), `is_active` bool

- `PRIMARY KEY (id)`

## collaboration_groups

`id` int8, `group_code` varchar, `run_code` uuid, `status` varchar, `matching_reason` jsonb (nullable), `created_at` timestamptz, `created_by_id` int8

- `FOREIGN KEY (created_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## cost_allocations

`id` int8, `baseline_cost` numeric, `allocation_weight` numeric (nullable), `order_count` int4 (nullable), `allocated_cost` numeric, `participant_saving` numeric, `outlet_id` int8, `evaluation_id` int8

- `FOREIGN KEY (evaluation_id) REFERENCES economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (outlet_id) REFERENCES outlets(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## cost_components

`id` int8, `ordinal` int4, `wave_no` int4 (nullable), `component_type` varchar, `amount` numeric, `source_type` varchar, `notes` text (nullable), `pricing_basis` varchar, `quantity` numeric (nullable), `unit_code` varchar (nullable), `unit_rate` numeric (nullable), `source_reference` varchar, `calculation_details` jsonb, `delivery_wave_id` int8 (nullable), `evaluation_id` int8

- `FOREIGN KEY (delivery_wave_id) REFERENCES delivery_waves(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (evaluation_id) REFERENCES economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## cost_profiles

`id` int8, `profile_code` varchar, `profile_name` varchar, `currency_code` bpchar, `fixed_transport_cost` numeric, `cost_per_km` numeric (nullable), `additional_handling_cost` numeric, `is_active` bool

- `PRIMARY KEY (id)`

## delivery_demands

`id` int8, `demand_code` varchar, `quantity_kg` numeric, `requested_date` date, `requested_start_time` time (nullable), `requested_end_time` time (nullable), `status` varchar, `notes` text (nullable), `created_at` timestamptz, `updated_at` timestamptz, `cargo_category_id` int8, `created_by_id` int8, `outlet_id` int8, `supplier_id` int8, `capstone_scenario` varchar

- `FOREIGN KEY (cargo_category_id) REFERENCES cargo_categories(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (created_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (outlet_id) REFERENCES outlets(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## delivery_waves

`id` int8, `wave_no` int4, `planned_date` date, `start_time` time (nullable), `end_time` time (nullable), `total_load_kg` numeric, `utilization_pct` numeric (nullable), `vehicle_type_id` int8, `plan_id` int8

- `FOREIGN KEY (plan_id) REFERENCES fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (vehicle_type_id) REFERENCES vehicle_types(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## demand_cost_inputs

`id` int8, `independent_delivery_cost` numeric, `currency_code` bpchar, `source_type` varchar, `effective_at` timestamptz, `notes` text (nullable), `cost_profile_id` int8 (nullable), `demand_id` int8, `evaluation_id` int8

- `FOREIGN KEY (cost_profile_id) REFERENCES cost_profiles(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (evaluation_id) REFERENCES economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## demand_items

`id` int8, `required_weight_kg` numeric, `unit_of_measure` varchar, `item_note` text (nullable), `demand_id` int8, `item_id` int8

- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (item_id) REFERENCES items(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## demand_sourcing_options

`id` int8, `option_type` varchar, `evaluation_status` varchar, `rank` int2 (nullable), `unit_price_vnd_per_kg_snapshot` numeric, `max_daily_supply_kg_snapshot` numeric (nullable), `lead_time_hours_snapshot` int4 (nullable), `exclusion_reason` text, `evaluated_at` timestamptz, `demand_item_id` int8, `supplier_item_id` int8

- `FOREIGN KEY (demand_item_id) REFERENCES demand_items(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_item_id) REFERENCES supplier_items(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## demand_supplier_selections

`id` int8, `selection_no` int2, `selection_reason` varchar, `selected_at` timestamptz, `demand_id` int8, `previous_request_id` int8, `previous_supplier_id` int8, `selected_by_id` int8, `selected_supplier_id` int8

- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (previous_request_id) REFERENCES supplier_requests(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (previous_supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (selected_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (selected_supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## django_admin_log

`id` int4, `action_time` timestamptz, `object_id` text (nullable), `object_repr` varchar, `action_flag` int2, `change_message` text, `content_type_id` int4 (nullable), `user_id` int8

- `FOREIGN KEY (content_type_id) REFERENCES django_content_type(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## django_content_type

`id` int4, `app_label` varchar, `model` varchar

- `PRIMARY KEY (id)`

## django_migrations

`id` int8, `app` varchar, `name` varchar, `applied` timestamptz

- `PRIMARY KEY (id)`

## django_session

`session_key` varchar, `session_data` text, `expire_date` timestamptz

- `PRIMARY KEY (session_key)`

## economic_evaluations

`id` int8, `evaluation_code` uuid, `baseline_cost` numeric, `collaborative_cost` numeric, `cost_saving` numeric, `saving_rate_pct` numeric (nullable), `allocation_method` varchar, `calculated_at` timestamptz, `contract_version` int2, `input_fingerprint` varchar, `configuration_fingerprint` varchar, `snapshot` jsonb, `sealed` bool, `calculated_by_id` int8, `cost_profile_id` int8 (nullable), `f4_evaluation_id` int8, `plan_id` int8

- `FOREIGN KEY (calculated_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (cost_profile_id) REFERENCES cost_profiles(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (f4_evaluation_id) REFERENCES f4_evaluations(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (plan_id) REFERENCES fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## external_user_access

`id` int8, `actor_type` varchar, `is_active` bool, `provider_id` int8 (nullable), `supplier_id` int8 (nullable), `user_id` int8

- `FOREIGN KEY (provider_id) REFERENCES transport_providers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## f3_evaluations

`id` int8, `evaluation_code` uuid, `contract_version` int2, `input_fingerprint` varchar, `configuration_fingerprint` varchar, `f3_structure` jsonb, `evaluated_at` timestamptz, `evaluated_by_id` int8, `plan_id` int8

- `FOREIGN KEY (evaluated_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (plan_id) REFERENCES fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## f4_evaluations

`id` int8, `evaluation_code` uuid, `contract_version` int2, `input_fingerprint` varchar, `configuration_fingerprint` varchar, `f4_structure` jsonb, `evaluated_at` timestamptz, `evaluated_by_id` int8, `f3_evaluation_id` int8

- `FOREIGN KEY (evaluated_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (f3_evaluation_id) REFERENCES f3_evaluations(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## final_plan_demands

`demand_id` int8, `plan_id` int8

- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (plan_id) REFERENCES final_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (demand_id)`

## final_plans

`id` int8, `code` uuid, `scope_key` varchar, `version` int4, `scenario` varchar, `snapshot` jsonb, `snapshot_hash` varchar, `provider_id` int8, `supersedes_id` int8 (nullable), `decision_id` int8

- `FOREIGN KEY (decision_id) REFERENCES plan_decisions(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (provider_id) REFERENCES transport_providers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supersedes_id) REFERENCES final_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## fulfillment_plans

`id` int8, `plan_code` varchar, `template_type` varchar, `status` varchar, `recommendation_reason` jsonb (nullable), `override_reason` text (nullable), `created_at` timestamptz, `updated_at` timestamptz, `created_by_id` int8, `group_id` int8, `hub_id` int8 (nullable), `supersedes_plan_id` int8 (nullable), `f2_structure` jsonb (nullable)

- `FOREIGN KEY (created_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (hub_id) REFERENCES hubs(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supersedes_plan_id) REFERENCES fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## group_demands

`eligibility_status` varchar, `matching_reason` jsonb (nullable), `demand_id` int8, `group_id` int8

- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (group_id, demand_id)`

## hub_coverage_evidence

`id` int8, `direction` varchar, `confirmation_status` varchar, `valid_from` date, `valid_through` date, `source` varchar, `source_reference` varchar, `uat_candidate_code` varchar, `recorded_at` timestamptz, `hub_id` int8, `outlet_id` int8 (nullable), `provider_id` int8, `supplier_id` int8 (nullable)

- `FOREIGN KEY (hub_id) REFERENCES hubs(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (outlet_id) REFERENCES outlets(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (provider_id) REFERENCES transport_providers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## hubs

`id` int8, `hub_code` varchar, `hub_name` varchar, `address` text, `is_active` bool, `created_at` timestamptz

- `PRIMARY KEY (id)`

## inventory_balances

`id` int8, `scenario` varchar, `on_hand_kg` numeric, `reserved_kg` numeric, `updated_at` timestamptz, `supplier_item_id` int8

- `FOREIGN KEY (supplier_item_id) REFERENCES supplier_items(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## inventory_reservations

`id` int8, `held_kg` numeric, `remaining_kg` numeric, `balance_id` int8, `promise_id` int8

- `FOREIGN KEY (balance_id) REFERENCES inventory_balances(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (promise_id) REFERENCES supplier_item_promises(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## inventory_transactions

`id` int8, `request_id` uuid (nullable), `kind` varchar, `on_hand_delta_kg` numeric, `reserved_delta_kg` numeric, `reason` varchar, `source_reference` varchar, `recorded_at` timestamptz, `actor_id` int8, `event_id` int8 (nullable), `balance_id` int8, `reservation_id` int8 (nullable)

- `FOREIGN KEY (actor_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (balance_id) REFERENCES inventory_balances(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (event_id) REFERENCES logistics_execution_events(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (reservation_id) REFERENCES inventory_reservations(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## items

`id` int8, `item_code` varchar, `item_name` varchar, `weight_unit` varchar, `item_description` text (nullable), `is_active` bool, `cargo_category_id` int8

- `FOREIGN KEY (cargo_category_id) REFERENCES cargo_categories(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## logistics_execution_events

`id` int8, `request_id` uuid, `wave` int4, `stop` int4, `action` varchar, `quantities` jsonb, `reason` varchar, `exception_code` varchar, `occurred_at` timestamptz, `provenance` varchar, `actor_id` int8, `demand_id` int8, `plan_id` int8

- `FOREIGN KEY (actor_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (plan_id) REFERENCES final_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## logistics_fleet_holds

`id` int8, `wave` int4, `starts_at` timestamptz, `ends_at` timestamptz, `evidence` jsonb, `released_at` timestamptz (nullable), `offer_id` int8, `plan_id` int8

- `FOREIGN KEY (offer_id) REFERENCES provider_vehicle_offers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (plan_id) REFERENCES final_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## logistics_reconciliation_records

`id` int8, `mode` varchar, `action` varchar, `request_id` uuid, `target` varchar, `reason` varchar, `evidence` jsonb, `recorded_at` timestamptz, `actor_id` int8, `plan_id` int8

- `FOREIGN KEY (actor_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (plan_id) REFERENCES final_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## operational_evidence

`id` int8, `kind` varchar, `business_key` varchar, `version` int4, `valid_from` date, `valid_to` date, `approval` varchar, `provenance` varchar, `scenario` varchar, `source_reference` varchar, `scope` jsonb, `data` jsonb, `recorded_at` timestamptz, `recorded_by_id` int8

- `FOREIGN KEY (recorded_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## outlets

`id` int8, `outlet_code` varchar, `outlet_name` varchar, `address` text, `contact_name` varchar (nullable), `phone` varchar (nullable), `is_active` bool, `created_at` timestamptz, `updated_at` timestamptz

- `PRIMARY KEY (id)`

## plan_decisions

`id` int8, `request_id` uuid, `outcome` varchar, `reason` text, `recorded_at` timestamptz, `actor_id` int8, `evaluation_id` int8, `group_id` int8

- `FOREIGN KEY (actor_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (evaluation_id) REFERENCES economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## planning_parameters

`id` int8, `parameter_key` varchar, `parameter_value` jsonb, `data_type` varchar, `description` text (nullable), `updated_at` timestamptz, `updated_by_id` int8 (nullable)

- `FOREIGN KEY (updated_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## planning_run_demands

`id` int8, `demand_snapshot` jsonb, `eligibility_status` varchar, `primary_reason_code` varchar (nullable), `plan_guard_status` varchar, `matching_status` varchar, `diagnostics` jsonb, `created_at` timestamptz, `updated_at` timestamptz, `demand_id` int8, `planning_run_id` int8

- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (planning_run_id) REFERENCES planning_runs(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## planning_runs

`id` int8, `run_code` uuid, `started_at` timestamptz, `completed_at` timestamptz (nullable), `status` varchar, `source_mode` varchar, `scenario_tag` varchar (nullable), `source_reference` varchar (nullable), `parameters_snapshot` jsonb, `cost_profile_id` int8 (nullable), `initiated_by_id` int8, `rule_set_id` int8, `failure_diagnostics` jsonb

- `FOREIGN KEY (cost_profile_id) REFERENCES cost_profiles(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (initiated_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (rule_set_id) REFERENCES rule_sets(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## provider_availability

`id` int8, `service_date` date, `available_vehicle_count` int4, `start_time` time, `end_time` time, `availability_status` varchar, `source_mode` varchar, `created_at` timestamptz, `updated_at` timestamptz, `provider_vehicle_id` int8

- `FOREIGN KEY (provider_vehicle_id) REFERENCES provider_vehicle_offers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## provider_supplier_coverage

`id` int8, `coverage_status` varchar, `can_pickup` bool, `service_note` text, `created_at` timestamptz, `updated_at` timestamptz, `provider_id` int8, `supplier_id` int8

- `FOREIGN KEY (provider_id) REFERENCES transport_providers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## provider_vehicle_offers

`id` int8, `available_vehicle_count` int4, `fuel_type` varchar, `operating_start_time` time (nullable), `operating_end_time` time (nullable), `fixed_quote_vnd` numeric (nullable), `estimated_cost_per_km_vnd` numeric (nullable), `is_active` bool, `vehicle_note` text, `created_at` timestamptz, `updated_at` timestamptz, `provider_id` int8, `vehicle_type_id` int8

- `FOREIGN KEY (provider_id) REFERENCES transport_providers(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (vehicle_type_id) REFERENCES vehicle_types(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## receiving_slots

`id` int8, `slot_date` date, `start_time` time, `end_time` time, `slot_type` varchar, `status` varchar, `reason` text (nullable), `source` varchar, `source_reference` varchar, `source_mode` varchar, `outlet_id` int8

- `FOREIGN KEY (outlet_id) REFERENCES outlets(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## receiving_windows

`id` int8, `day_of_week` int2, `start_time` time, `end_time` time, `is_active` bool, `source` varchar, `source_reference` varchar, `source_mode` varchar, `outlet_id` int8

- `FOREIGN KEY (outlet_id) REFERENCES outlets(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## roles

`id` int8, `code` varchar, `name` varchar, `description` text, `is_active` bool

- `PRIMARY KEY (id)`

## rule_sets

`id` int8, `rule_set_code` varchar, `rule_set_name` varchar, `version_no` int4, `status` varchar, `effective_from` timestamptz (nullable), `created_by_id` int8

- `FOREIGN KEY (created_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## supplier_confirmations

`id` int8, `confirmation_status` varchar, `source_mode` varchar, `ready_date` date (nullable), `ready_start_time` time (nullable), `ready_end_time` time (nullable), `pickup_address` text (nullable), `recorded_at` timestamptz (nullable), `confirmation_note` text, `commitment_released_at` timestamptz (nullable), `commitment_release_note` text, `created_at` timestamptz, `updated_at` timestamptz, `commitment_released_by_id` int8 (nullable), `demand_id` int8, `supplier_id` int8

- `FOREIGN KEY (commitment_released_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## supplier_item_promises

`id` int8, `promised_weight_kg` numeric, `confirmed_weight_kg` numeric, `line_status` varchar, `unit_price_vnd_per_kg_snapshot` numeric, `lead_time_hours_snapshot` int4 (nullable), `created_at` timestamptz, `updated_at` timestamptz, `demand_item_id` int8, `supplier_item_id` int8, `supplier_request_id` int8, `decline_reason` text

- `FOREIGN KEY (demand_item_id) REFERENCES demand_items(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_item_id) REFERENCES supplier_items(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_request_id) REFERENCES supplier_requests(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## supplier_items

`id` int8, `unit_price_vnd_per_kg` numeric, `max_daily_supply_kg` numeric (nullable), `lead_time_hours` int4 (nullable), `minimum_order_kg` numeric (nullable), `offer_status` varchar, `updated_at` timestamptz, `item_id` int8, `supplier_id` int8

- `FOREIGN KEY (item_id) REFERENCES items(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## supplier_requests

`id` int8, `request_code` varchar, `attempt_no` int2, `request_status` varchar, `sent_at` timestamptz, `responded_at` timestamptz (nullable), `created_at` timestamptz, `updated_at` timestamptz, `created_by_id` int8, `demand_id` int8, `supplier_id` int8, `supplier_confirmation_id` int8

- `FOREIGN KEY (created_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_confirmation_id) REFERENCES supplier_confirmations(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (supplier_id) REFERENCES suppliers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## suppliers

`id` int8, `supplier_code` varchar, `supplier_name` varchar, `contact_name` varchar (nullable), `phone` varchar (nullable), `email` varchar (nullable), `address` text (nullable), `is_active` bool, `created_at` timestamptz, `updated_at` timestamptz

- `PRIMARY KEY (id)`

## transport_handover_responses

`id` int8, `outcome` varchar, `reason` text, `responded_at` timestamptz, `actor_id` int8, `handover_id` int8

- `FOREIGN KEY (actor_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (handover_id) REFERENCES transport_handovers(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## transport_handovers

`id` int8, `sent_at` timestamptz, `actor_id` int8, `plan_id` int8

- `FOREIGN KEY (actor_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (plan_id) REFERENCES final_plans(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## transport_providers

`id` int8, `provider_code` varchar, `provider_name` varchar, `provider_type` varchar, `service_region` text, `contact_email` varchar, `is_active` bool

- `PRIMARY KEY (id)`

## user_outlet_access

`id` int8, `is_active` bool, `assigned_at` timestamptz, `assigned_by_id` int8 (nullable), `outlet_id` int8, `user_id` int8

- `FOREIGN KEY (assigned_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (outlet_id) REFERENCES outlets(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## user_roles

`id` int8, `assigned_at` timestamptz, `assigned_by_id` int8 (nullable), `role_id` int8, `user_id` int8, `is_active` bool

- `FOREIGN KEY (assigned_by_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (role_id) REFERENCES roles(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## users

`id` int8, `password` varchar, `is_superuser` bool, `email` varchar, `full_name` varchar, `is_active` bool, `is_staff` bool, `last_login_at` timestamptz (nullable), `created_at` timestamptz, `updated_at` timestamptz, `capstone_scenario` varchar

- `PRIMARY KEY (id)`

## users_groups

`id` int8, `user_id` int8, `group_id` int4

- `FOREIGN KEY (group_id) REFERENCES auth_group(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## users_user_permissions

`id` int8, `user_id` int8, `permission_id` int4

- `FOREIGN KEY (permission_id) REFERENCES auth_permission(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (user_id) REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (id)`

## vehicle_cargo_compatibility

`is_supported` bool, `source` varchar (nullable), `cargo_category_id` int8, `vehicle_type_id` int8

- `FOREIGN KEY (cargo_category_id) REFERENCES cargo_categories(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (vehicle_type_id) REFERENCES vehicle_types(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (vehicle_type_id, cargo_category_id)`

## vehicle_types

`id` int8, `vehicle_code` varchar, `vehicle_name` varchar, `capacity_kg` numeric, `description` text (nullable), `is_active` bool

- `PRIMARY KEY (id)`

## wave_demands

`allocated_quantity_kg` numeric, `demand_id` int8, `wave_id` int8

- `FOREIGN KEY (demand_id) REFERENCES delivery_demands(id) DEFERRABLE INITIALLY DEFERRED`
- `FOREIGN KEY (wave_id) REFERENCES delivery_waves(id) DEFERRABLE INITIALLY DEFERRED`
- `PRIMARY KEY (wave_id, demand_id)`
