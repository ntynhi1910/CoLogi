--
-- PostgreSQL database dump
--

\restrict Ik49dWbBQWEmDeGtHNviW3rZvVvkU75D6cNt9eRF96tz9qruiqCRlz4Xpk6oMmL

-- Dumped from database version 17.12
-- Dumped by pg_dump version 17.12

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: cp09_cp10_require_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cp09_cp10_require_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
                BEGIN
                    RAISE EXCEPTION 'Published planning workflow records are append-only'
                        USING ERRCODE = '55000';
                END;
                $$;


--
-- Name: planning_block_f3_evaluation_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.planning_block_f3_evaluation_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            BEGIN
                RAISE EXCEPTION 'Saved F3 evaluations are immutable' USING ERRCODE = '55000';
            END;
            $$;


--
-- Name: planning_block_f4_evaluation_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.planning_block_f4_evaluation_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            BEGIN
                RAISE EXCEPTION 'Saved F4 evaluations are immutable' USING ERRCODE = '55000';
            END;
            $$;


--
-- Name: planning_f5_child_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.planning_f5_child_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent_sealed boolean;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Saved F5 cost rows are immutable' USING ERRCODE = '55000';
    END IF;
    SELECT sealed INTO parent_sealed FROM economic_evaluations WHERE id = NEW.evaluation_id FOR UPDATE;
    IF parent_sealed IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'F5 cost rows require an open evaluation' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: planning_f5_require_sealed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.planning_f5_require_sealed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT FROM economic_evaluations WHERE id=NEW.id AND sealed) THEN
        RAISE EXCEPTION 'F5 evaluation must be sealed before commit' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: planning_f5_seal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.planning_f5_seal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    source record;
    outcome jsonb;
    baseline jsonb;
    allocated jsonb;
    components jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.sealed THEN
            RAISE EXCEPTION 'F5 evaluations must be inserted open' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Saved F5 evaluations are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW) - 'sealed') IS DISTINCT FROM (to_jsonb(OLD) - 'sealed') THEN
        RAISE EXCEPTION 'Saved F5 evaluations are immutable' USING ERRCODE = '55000';
    END IF;

    SELECT f4.evaluation_code, f4.evaluated_by_id, f4.f4_structure, f3.plan_id
      INTO source FROM f4_evaluations f4 JOIN f3_evaluations f3 ON f3.id=f4.f3_evaluation_id
     WHERE f4.id=NEW.f4_evaluation_id;
    IF source.plan_id IS DISTINCT FROM NEW.plan_id OR source.evaluated_by_id IS DISTINCT FROM NEW.calculated_by_id
       OR source.f4_structure #>> '{result,status}' IS DISTINCT FROM 'PASS'
       OR source.f4_structure #>> '{result,complete}' IS DISTINCT FROM 'true'
       OR NEW.snapshot #>> '{lineage,f4_evaluation_code}' IS DISTINCT FROM source.evaluation_code::text
       OR NEW.snapshot #>> '{lineage,evaluation_context}' IS DISTINCT FROM source.f4_structure #>> '{inputs,evaluation_context}' THEN
        RAISE EXCEPTION 'F5 snapshot does not match its eligible F4 evaluation' USING ERRCODE = '23514';
    END IF;
    outcome := NEW.snapshot #> '{result,option}';
    baseline := NEW.snapshot #> '{result,baseline_inputs}';
    allocated := outcome->'allocations';
    components := outcome->'components';
    IF outcome->>'status' IS DISTINCT FROM 'EVALUATED'
       OR NEW.snapshot #>> '{configuration,allocation_method}' IS DISTINCT FROM NEW.allocation_method
       OR (NEW.snapshot #>> '{result,baseline_cost}')::numeric IS DISTINCT FROM NEW.baseline_cost
       OR (outcome->>'collaborative_cost')::numeric IS DISTINCT FROM NEW.collaborative_cost
       OR (outcome->>'cost_saving')::numeric IS DISTINCT FROM NEW.cost_saving
       OR (outcome->>'saving_rate_pct')::numeric IS DISTINCT FROM NEW.saving_rate_pct
       OR (CASE WHEN NEW.baseline_cost > 0 THEN round(NEW.cost_saving * 100 / NEW.baseline_cost, 4) END)
          IS DISTINCT FROM NEW.saving_rate_pct
       OR coalesce(jsonb_array_length(baseline),0) = 0
       OR coalesce(jsonb_array_length(allocated),0) = 0
       OR coalesce(jsonb_array_length(components),0) = 0 THEN
        RAISE EXCEPTION 'F5 totals or snapshot are invalid' USING ERRCODE = '23514';
    END IF;
    IF (SELECT (count(*),sum(independent_delivery_cost)) FROM demand_cost_inputs WHERE evaluation_id=NEW.id)
           IS DISTINCT FROM (jsonb_array_length(baseline)::bigint,NEW.baseline_cost)
       OR (SELECT (count(*),sum(allocated_cost),sum(baseline_cost),sum(participant_saving))
             FROM cost_allocations WHERE evaluation_id=NEW.id)
           IS DISTINCT FROM (jsonb_array_length(allocated)::bigint,NEW.collaborative_cost,NEW.baseline_cost,NEW.cost_saving)
       OR (SELECT (count(*),sum(amount)) FROM cost_components WHERE evaluation_id=NEW.id)
           IS DISTINCT FROM (jsonb_array_length(components)::bigint,NEW.collaborative_cost) THEN
        RAISE EXCEPTION 'F5 cost lines do not reconcile' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM demand_cost_inputs d WHERE evaluation_id=NEW.id AND NOT EXISTS (
            SELECT FROM jsonb_array_elements(baseline) item
            WHERE (item->>'demand_id')::bigint=d.demand_id AND (item->>'amount')::numeric=d.independent_delivery_cost
        )
    ) OR EXISTS (
        SELECT 1 FROM cost_allocations a WHERE evaluation_id=NEW.id AND NOT EXISTS (
            SELECT FROM jsonb_array_elements(allocated) item WHERE (item->>'outlet_id')::bigint=a.outlet_id
              AND (item->>'baseline_cost')::numeric=a.baseline_cost AND (item->>'allocated_cost')::numeric=a.allocated_cost
              AND (item->>'weight_kg')::numeric IS NOT DISTINCT FROM a.allocation_weight
              AND (item->>'order_count')::integer IS NOT DISTINCT FROM a.order_count
        )
    ) OR EXISTS (
        SELECT 1 FROM cost_components c WHERE evaluation_id=NEW.id AND (
           c.calculation_details IS DISTINCT FROM (components -> (c.ordinal - 1))
           OR c.amount IS DISTINCT FROM (c.calculation_details->>'amount')::numeric
           OR c.wave_no IS DISTINCT FROM (c.calculation_details->>'wave_no')::integer
           OR (c.wave_no IS NOT NULL AND NOT EXISTS (
              SELECT FROM jsonb_array_elements(source.f4_structure #> '{result,waves}') wave
               WHERE (wave->>'wave_no')::integer=c.wave_no
           ))
           OR (c.delivery_wave_id IS NOT NULL AND NOT EXISTS (
              SELECT FROM delivery_waves w
               WHERE w.id=c.delivery_wave_id AND w.plan_id=NEW.plan_id AND w.wave_no=c.wave_no
           ))
        )
    ) THEN
        RAISE EXCEPTION 'F5 cost lines do not match the saved snapshot' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    action character varying(50) NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_id character varying(100),
    old_values jsonb,
    new_values jsonb,
    ip_address inet,
    created_at timestamp with time zone NOT NULL,
    actor_user_id bigint
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_group (
    id integer NOT NULL,
    name character varying(150) NOT NULL
);


--
-- Name: auth_group_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_group ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_group_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_group_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_group_permissions (
    id bigint NOT NULL,
    group_id integer NOT NULL,
    permission_id integer NOT NULL
);


--
-- Name: auth_group_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_group_permissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_group_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_permission (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    content_type_id integer NOT NULL,
    codename character varying(100) NOT NULL
);


--
-- Name: auth_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_permission ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_permission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: authtoken_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authtoken_token (
    key character varying(40) NOT NULL,
    created timestamp with time zone NOT NULL,
    user_id bigint NOT NULL
);


--
-- Name: business_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_rules (
    id bigint NOT NULL,
    rule_code character varying(50) NOT NULL,
    module_code character varying(5) NOT NULL,
    rule_name character varying(150) NOT NULL,
    description text,
    rule_definition jsonb NOT NULL,
    priority integer NOT NULL,
    is_active boolean NOT NULL,
    rule_set_id bigint NOT NULL,
    CONSTRAINT business_rules_priority_check CHECK ((priority >= 0)),
    CONSTRAINT ck_business_rules_module_valid CHECK (((module_code)::text = ANY (ARRAY[('F1'::character varying)::text, ('F2'::character varying)::text, ('F3'::character varying)::text, ('F4'::character varying)::text, ('F5'::character varying)::text]))),
    CONSTRAINT ck_business_rules_priority_nonnegative CHECK ((priority >= 0))
);


--
-- Name: business_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.business_rules ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.business_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cargo_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cargo_categories (
    id bigint NOT NULL,
    category_code character varying(30) NOT NULL,
    category_name character varying(150) NOT NULL,
    description text,
    is_active boolean NOT NULL
);


--
-- Name: cargo_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cargo_categories ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.cargo_categories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collaboration_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collaboration_groups (
    id bigint NOT NULL,
    group_code character varying(40) NOT NULL,
    run_code uuid NOT NULL,
    status character varying(20) NOT NULL,
    matching_reason jsonb,
    created_at timestamp with time zone NOT NULL,
    created_by_id bigint NOT NULL,
    CONSTRAINT ck_collaboration_groups_status CHECK (((status)::text = ANY (ARRAY[('CANDIDATE'::character varying)::text, ('ACCEPTED'::character varying)::text, ('MODIFIED'::character varying)::text, ('REJECTED'::character varying)::text])))
);


--
-- Name: collaboration_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.collaboration_groups ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.collaboration_groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cost_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_allocations (
    id bigint NOT NULL,
    baseline_cost numeric(14,2) NOT NULL,
    allocation_weight numeric(14,3),
    order_count integer,
    allocated_cost numeric(14,2) NOT NULL,
    participant_saving numeric(14,2) NOT NULL,
    outlet_id bigint NOT NULL,
    evaluation_id bigint NOT NULL,
    CONSTRAINT ck_f5_allocation_costs CHECK (((allocated_cost >= (0)::numeric) AND (baseline_cost >= (0)::numeric) AND (participant_saving = (baseline_cost - allocated_cost)))),
    CONSTRAINT ck_f5_allocation_weight CHECK (((allocation_weight IS NULL) OR (allocation_weight >= (0)::numeric))),
    CONSTRAINT cost_allocations_order_count_check CHECK ((order_count >= 0))
);


--
-- Name: cost_allocations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cost_allocations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.cost_allocations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cost_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_components (
    id bigint NOT NULL,
    ordinal integer NOT NULL,
    wave_no integer,
    component_type character varying(30) NOT NULL,
    amount numeric(14,2) NOT NULL,
    source_type character varying(30) NOT NULL,
    notes text,
    pricing_basis character varying(20) NOT NULL,
    quantity numeric(20,6),
    unit_code character varying(20),
    unit_rate numeric(14,2),
    source_reference character varying(180) NOT NULL,
    calculation_details jsonb NOT NULL,
    delivery_wave_id bigint,
    evaluation_id bigint NOT NULL,
    CONSTRAINT ck_f5_component_domain CHECK (((amount >= (0)::numeric) AND ((component_type)::text = ANY (ARRAY[('TRANSPORT'::character varying)::text, ('HUB_HANDLING'::character varying)::text, ('HANDLING'::character varying)::text, ('OTHER'::character varying)::text])) AND (ordinal >= 1) AND ((pricing_basis)::text = ANY (ARRAY[('FIXED'::character varying)::text, ('PER_KM'::character varying)::text, ('PER_KG'::character varying)::text, ('PER_ORDER'::character varying)::text, ('BUNDLED'::character varying)::text, ('OTHER'::character varying)::text])))),
    CONSTRAINT ck_f5_component_trace CHECK ((((quantity IS NULL) OR (quantity >= (0)::numeric)) AND ((unit_rate IS NULL) OR (unit_rate >= (0)::numeric)) AND ((wave_no IS NULL) OR (wave_no >= 1)) AND ((source_reference)::text ~ '\S'::text) AND ((source_type)::text ~ '\S'::text))),
    CONSTRAINT cost_components_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT cost_components_wave_no_check CHECK ((wave_no >= 0))
);


--
-- Name: cost_components_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cost_components ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.cost_components_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cost_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_profiles (
    id bigint NOT NULL,
    profile_code character varying(40) NOT NULL,
    profile_name character varying(150) NOT NULL,
    currency_code character(3) NOT NULL,
    fixed_transport_cost numeric(14,2) NOT NULL,
    cost_per_km numeric(14,2),
    additional_handling_cost numeric(14,2) NOT NULL,
    is_active boolean NOT NULL,
    CONSTRAINT ck_cost_profiles_currency_vnd CHECK ((currency_code = 'VND'::bpchar)),
    CONSTRAINT ck_cost_profiles_fixed_nonnegative CHECK ((fixed_transport_cost >= (0)::numeric)),
    CONSTRAINT ck_cost_profiles_handling_nonnegative CHECK ((additional_handling_cost >= (0)::numeric)),
    CONSTRAINT ck_cost_profiles_per_km_nonnegative CHECK (((cost_per_km IS NULL) OR (cost_per_km >= (0)::numeric)))
);


--
-- Name: cost_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cost_profiles ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.cost_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: delivery_demands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_demands (
    id bigint NOT NULL,
    demand_code character varying(40) NOT NULL,
    quantity_kg numeric(12,3) NOT NULL,
    requested_date date NOT NULL,
    requested_start_time time without time zone,
    requested_end_time time without time zone,
    status character varying(20) NOT NULL,
    notes text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    cargo_category_id bigint NOT NULL,
    created_by_id bigint NOT NULL,
    outlet_id bigint NOT NULL,
    supplier_id bigint NOT NULL,
    capstone_scenario character varying(50) NOT NULL,
    CONSTRAINT dem_quantity_positive CHECK ((quantity_kg > (0)::numeric)),
    CONSTRAINT dem_requested_time_order CHECK (((requested_start_time IS NULL) OR (requested_end_time IS NULL) OR (requested_start_time < requested_end_time))),
    CONSTRAINT dem_status_valid CHECK (((status)::text = ANY (ARRAY[('DRAFT'::character varying)::text, ('SUBMITTED'::character varying)::text, ('PLANNING'::character varying)::text, ('PLANNED'::character varying)::text, ('CANCELLED'::character varying)::text])))
);


--
-- Name: delivery_demands_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.delivery_demands ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.delivery_demands_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: delivery_waves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_waves (
    id bigint NOT NULL,
    wave_no integer NOT NULL,
    planned_date date NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    total_load_kg numeric(12,3) NOT NULL,
    utilization_pct numeric(5,2),
    vehicle_type_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    CONSTRAINT ck_delivery_wave_load CHECK ((total_load_kg >= (0)::numeric)),
    CONSTRAINT ck_delivery_wave_number CHECK ((wave_no > 0)),
    CONSTRAINT ck_delivery_wave_utilization CHECK (((utilization_pct IS NULL) OR ((utilization_pct >= (0)::numeric) AND (utilization_pct <= (100)::numeric)))),
    CONSTRAINT delivery_waves_wave_no_check CHECK ((wave_no >= 0))
);


--
-- Name: delivery_waves_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.delivery_waves ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.delivery_waves_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: demand_cost_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_cost_inputs (
    id bigint NOT NULL,
    independent_delivery_cost numeric(14,2) NOT NULL,
    currency_code character(3) NOT NULL,
    source_type character varying(30) NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    notes text,
    cost_profile_id bigint,
    demand_id bigint NOT NULL,
    evaluation_id bigint NOT NULL,
    CONSTRAINT ck_f5_cost_input_source CHECK (((currency_code = 'VND'::bpchar) AND (independent_delivery_cost >= (0)::numeric) AND ((source_type)::text ~ '\S'::text)))
);


--
-- Name: demand_cost_inputs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.demand_cost_inputs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.demand_cost_inputs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: demand_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_items (
    id bigint NOT NULL,
    required_weight_kg numeric(12,3) NOT NULL,
    unit_of_measure character varying(10) NOT NULL,
    item_note text,
    demand_id bigint NOT NULL,
    item_id bigint NOT NULL,
    CONSTRAINT di_weight_positive CHECK ((required_weight_kg > (0)::numeric))
);


--
-- Name: demand_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.demand_items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.demand_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: demand_sourcing_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_sourcing_options (
    id bigint NOT NULL,
    option_type character varying(24) NOT NULL,
    evaluation_status character varying(12) NOT NULL,
    rank smallint,
    unit_price_vnd_per_kg_snapshot numeric(18,2) NOT NULL,
    max_daily_supply_kg_snapshot numeric(12,3),
    lead_time_hours_snapshot integer,
    exclusion_reason text NOT NULL,
    evaluated_at timestamp with time zone NOT NULL,
    demand_item_id bigint NOT NULL,
    supplier_item_id bigint NOT NULL,
    CONSTRAINT demand_sourcing_options_rank_check CHECK ((rank >= 0)),
    CONSTRAINT dso_capacity_positive CHECK (((max_daily_supply_kg_snapshot IS NULL) OR (max_daily_supply_kg_snapshot > (0)::numeric))),
    CONSTRAINT dso_eval_status_valid CHECK (((evaluation_status)::text = ANY (ARRAY[('ELIGIBLE'::character varying)::text, ('INELIGIBLE'::character varying)::text]))),
    CONSTRAINT dso_lead_nonnegative CHECK (((lead_time_hours_snapshot IS NULL) OR (lead_time_hours_snapshot >= 0))),
    CONSTRAINT dso_option_type_valid CHECK (((option_type)::text = ANY (ARRAY[('SELECTED_EXISTING'::character varying)::text, ('ALTERNATIVE_ONLY'::character varying)::text]))),
    CONSTRAINT dso_price_nonnegative CHECK ((unit_price_vnd_per_kg_snapshot >= (0)::numeric)),
    CONSTRAINT dso_rank_positive CHECK (((rank IS NULL) OR (rank > 0)))
);


--
-- Name: demand_sourcing_options_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.demand_sourcing_options ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.demand_sourcing_options_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: demand_supplier_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_supplier_selections (
    id bigint NOT NULL,
    selection_no smallint NOT NULL,
    selection_reason character varying(32) NOT NULL,
    selected_at timestamp with time zone NOT NULL,
    demand_id bigint NOT NULL,
    previous_request_id bigint NOT NULL,
    previous_supplier_id bigint NOT NULL,
    selected_by_id bigint NOT NULL,
    selected_supplier_id bigint NOT NULL,
    CONSTRAINT demand_supplier_selections_selection_no_check CHECK ((selection_no >= 0)),
    CONSTRAINT dss_reason_valid CHECK (((selection_reason)::text = ANY (ARRAY[('RETRY_AFTER_EXPIRED'::character varying)::text, ('RETRY_AFTER_CANCELLED'::character varying)::text, ('REPLACE_AFTER_DECLINED'::character varying)::text, ('REPLACE_AFTER_PARTIAL'::character varying)::text]))),
    CONSTRAINT dss_selection_positive CHECK ((selection_no > 0)),
    CONSTRAINT dss_supplier_change_valid CHECK ((((selection_reason)::text = ANY (ARRAY[('RETRY_AFTER_EXPIRED'::character varying)::text, ('RETRY_AFTER_CANCELLED'::character varying)::text])) OR (NOT (selected_supplier_id = previous_supplier_id))))
);


--
-- Name: demand_supplier_selections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.demand_supplier_selections ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.demand_supplier_selections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_admin_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_admin_log (
    id integer NOT NULL,
    action_time timestamp with time zone NOT NULL,
    object_id text,
    object_repr character varying(200) NOT NULL,
    action_flag smallint NOT NULL,
    change_message text NOT NULL,
    content_type_id integer,
    user_id bigint NOT NULL,
    CONSTRAINT django_admin_log_action_flag_check CHECK ((action_flag >= 0))
);


--
-- Name: django_admin_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.django_admin_log ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.django_admin_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_content_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_content_type (
    id integer NOT NULL,
    app_label character varying(100) NOT NULL,
    model character varying(100) NOT NULL
);


--
-- Name: django_content_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.django_content_type ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.django_content_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_migrations (
    id bigint NOT NULL,
    app character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    applied timestamp with time zone NOT NULL
);


--
-- Name: django_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.django_migrations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.django_migrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_session (
    session_key character varying(40) NOT NULL,
    session_data text NOT NULL,
    expire_date timestamp with time zone NOT NULL
);


--
-- Name: economic_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.economic_evaluations (
    id bigint NOT NULL,
    evaluation_code uuid NOT NULL,
    baseline_cost numeric(14,2) NOT NULL,
    collaborative_cost numeric(14,2) NOT NULL,
    cost_saving numeric(14,2) NOT NULL,
    saving_rate_pct numeric(9,4),
    allocation_method character varying(20) NOT NULL,
    calculated_at timestamp with time zone NOT NULL,
    contract_version smallint NOT NULL,
    input_fingerprint character varying(64) NOT NULL,
    configuration_fingerprint character varying(64) NOT NULL,
    snapshot jsonb NOT NULL,
    sealed boolean NOT NULL,
    calculated_by_id bigint NOT NULL,
    cost_profile_id bigint,
    f4_evaluation_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    CONSTRAINT ck_f5_evaluation_costs CHECK (((baseline_cost >= (0)::numeric) AND (collaborative_cost >= (0)::numeric) AND (cost_saving = (baseline_cost - collaborative_cost)))),
    CONSTRAINT ck_f5_evaluation_metadata CHECK ((((allocation_method)::text = ANY (ARRAY[('WEIGHT'::character varying)::text, ('ORDER_COUNT'::character varying)::text])) AND ((configuration_fingerprint)::text ~ '^[0-9a-f]{64}$'::text) AND (contract_version >= 1) AND ((input_fingerprint)::text ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT ck_f5_evaluation_rate CHECK ((((baseline_cost = (0)::numeric) AND (saving_rate_pct IS NULL)) OR ((baseline_cost > (0)::numeric) AND (saving_rate_pct IS NOT NULL)))),
    CONSTRAINT ck_f5_evaluation_snapshot CHECK (((jsonb_typeof(snapshot) = 'object'::text) AND (snapshot ?& '{lineage,configuration,price_inputs,result,comparison}'::text[]))),
    CONSTRAINT economic_evaluations_contract_version_check CHECK ((contract_version >= 0))
);


--
-- Name: economic_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.economic_evaluations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.economic_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: external_user_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_user_access (
    id bigint NOT NULL,
    actor_type character varying(30) NOT NULL,
    is_active boolean NOT NULL,
    provider_id bigint,
    supplier_id bigint,
    user_id bigint NOT NULL,
    CONSTRAINT acc_ext_access_valid_scope CHECK (((((actor_type)::text = 'SUPPLIER'::text) AND (provider_id IS NULL) AND (supplier_id IS NOT NULL)) OR (((actor_type)::text = 'TRANSPORT_PROVIDER'::text) AND (provider_id IS NOT NULL) AND (supplier_id IS NULL))))
);


--
-- Name: external_user_access_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.external_user_access ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.external_user_access_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: f3_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.f3_evaluations (
    id bigint NOT NULL,
    evaluation_code uuid NOT NULL,
    contract_version smallint NOT NULL,
    input_fingerprint character varying(64) NOT NULL,
    configuration_fingerprint character varying(64) NOT NULL,
    f3_structure jsonb NOT NULL,
    evaluated_at timestamp with time zone NOT NULL,
    evaluated_by_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    CONSTRAINT ck_f3_evaluation_document CHECK (((jsonb_typeof(f3_structure) = 'object'::text) AND (f3_structure ?& '{inputs,configuration,result}'::text[]))),
    CONSTRAINT ck_f3_evaluation_hashes CHECK ((((configuration_fingerprint)::text ~ '^[0-9a-f]{64}$'::text) AND ((input_fingerprint)::text ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT ck_f3_evaluation_version CHECK ((contract_version >= 1)),
    CONSTRAINT f3_evaluations_contract_version_check CHECK ((contract_version >= 0))
);


--
-- Name: f3_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.f3_evaluations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.f3_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: f4_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.f4_evaluations (
    id bigint NOT NULL,
    evaluation_code uuid NOT NULL,
    contract_version smallint NOT NULL,
    input_fingerprint character varying(64) NOT NULL,
    configuration_fingerprint character varying(64) NOT NULL,
    f4_structure jsonb NOT NULL,
    evaluated_at timestamp with time zone NOT NULL,
    evaluated_by_id bigint NOT NULL,
    f3_evaluation_id bigint NOT NULL,
    CONSTRAINT ck_f4_evaluation_document CHECK (((jsonb_typeof(f4_structure) = 'object'::text) AND (f4_structure ?& '{inputs,configuration,result}'::text[]) AND ((f4_structure -> 'inputs'::text) ?& '{lineage,f2,f3,time_evidence,evaluation_context}'::text[]) AND ((f4_structure -> 'result'::text) ?& '{status,complete,waves,metrics,diagnostics}'::text[]) AND ((f4_structure #> '{result,status}'::text[]) = ANY (ARRAY['"PASS"'::jsonb, '"HARD_CONFLICT"'::jsonb, '"SOFT_CONFLICT"'::jsonb, '"NOT_EVALUATED"'::jsonb])))),
    CONSTRAINT ck_f4_evaluation_hashes CHECK ((((configuration_fingerprint)::text ~ '^[0-9a-f]{64}$'::text) AND ((input_fingerprint)::text ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT ck_f4_evaluation_version CHECK ((contract_version >= 1)),
    CONSTRAINT f4_evaluations_contract_version_check CHECK ((contract_version >= 0))
);


--
-- Name: f4_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.f4_evaluations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.f4_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: final_plan_demands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.final_plan_demands (
    demand_id bigint NOT NULL,
    plan_id bigint NOT NULL
);


--
-- Name: final_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.final_plans (
    id bigint NOT NULL,
    code uuid NOT NULL,
    scope_key character varying(64) NOT NULL,
    version integer NOT NULL,
    scenario character varying(50) NOT NULL,
    snapshot jsonb NOT NULL,
    snapshot_hash character varying(64) NOT NULL,
    provider_id bigint NOT NULL,
    supersedes_id bigint,
    decision_id bigint NOT NULL,
    CONSTRAINT ck_final_plan_revision CHECK ((((supersedes_id IS NULL) AND (version = 1)) OR ((supersedes_id IS NOT NULL) AND (version > 1)))),
    CONSTRAINT ck_final_plan_snapshot CHECK ((((scope_key)::text ~ '^[0-9a-f]{64}$'::text) AND ((snapshot_hash)::text ~ '^[0-9a-f]{64}$'::text) AND (snapshot ?& '{schema_version,f1,f2,f3,f4,f5,provenance}'::text[]))),
    CONSTRAINT final_plans_version_check CHECK ((version >= 0))
);


--
-- Name: final_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.final_plans ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.final_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: fulfillment_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_plans (
    id bigint NOT NULL,
    plan_code character varying(40) NOT NULL,
    template_type character varying(30) NOT NULL,
    status character varying(25) NOT NULL,
    recommendation_reason jsonb,
    override_reason text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by_id bigint NOT NULL,
    group_id bigint NOT NULL,
    hub_id bigint,
    supersedes_plan_id bigint,
    f2_structure jsonb,
    CONSTRAINT ck_fulfillment_plan_f2_structure CHECK (((f2_structure IS NULL) OR ((jsonb_typeof(f2_structure) = 'object'::text) AND (f2_structure ?& '{schema_version,lineage,basis,option}'::text[]) AND ((f2_structure -> 'schema_version'::text) = '1'::jsonb) AND ((f2_structure -> 'option'::text) ?& '{template_type,structural_status,hub}'::text[]) AND ((f2_structure #> '{option,structural_status}'::text[]) = '"COMPLETE"'::jsonb) AND ((f2_structure #>> '{option,template_type}'::text[]) = (template_type)::text) AND ((((f2_structure #> '{option,hub}'::text[]) = 'null'::jsonb) AND (hub_id IS NULL) AND ((template_type)::text = 'DIRECT_CONSOLIDATED'::text)) OR (((f2_structure #> '{option,hub}'::text[]) ? 'id'::text) AND (hub_id IS NOT NULL) AND ((template_type)::text = 'HUB_BASED'::text)))))),
    CONSTRAINT ck_fulfillment_plan_not_self CHECK ((NOT ((supersedes_plan_id = id) AND (supersedes_plan_id IS NOT NULL)))),
    CONSTRAINT ck_fulfillment_plan_status CHECK (((status)::text = ANY (ARRAY[('DRAFT'::character varying)::text, ('VALIDATING'::character varying)::text, ('PENDING_APPROVAL'::character varying)::text, ('APPROVED'::character varying)::text, ('REJECTED'::character varying)::text, ('FINALIZED'::character varying)::text]))),
    CONSTRAINT ck_fulfillment_plan_template CHECK (((template_type)::text = ANY (ARRAY[('DIRECT_CONSOLIDATED'::character varying)::text, ('HUB_BASED'::character varying)::text])))
);


--
-- Name: fulfillment_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.fulfillment_plans ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.fulfillment_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: group_demands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_demands (
    eligibility_status character varying(20) NOT NULL,
    matching_reason jsonb,
    demand_id bigint NOT NULL,
    group_id bigint NOT NULL,
    CONSTRAINT ck_group_demands_eligibility CHECK (((eligibility_status)::text = ANY (ARRAY[('INCLUDED'::character varying)::text, ('EXCLUDED'::character varying)::text])))
);


--
-- Name: hub_coverage_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hub_coverage_evidence (
    id bigint NOT NULL,
    direction character varying(8) NOT NULL,
    confirmation_status character varying(12) NOT NULL,
    valid_from date NOT NULL,
    valid_through date NOT NULL,
    source character varying(30) NOT NULL,
    source_reference character varying(255) NOT NULL,
    uat_candidate_code character varying(40) NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    hub_id bigint NOT NULL,
    outlet_id bigint,
    provider_id bigint NOT NULL,
    supplier_id bigint,
    CONSTRAINT tr_hub_cov_confirmation CHECK (((confirmation_status)::text = ANY (ARRAY[('CONFIRMED'::character varying)::text, ('PENDING'::character varying)::text, ('REVOKED'::character varying)::text]))),
    CONSTRAINT tr_hub_cov_direction_endpoint CHECK (((((direction)::text = 'INBOUND'::text) AND (outlet_id IS NULL) AND (supplier_id IS NOT NULL)) OR (((direction)::text = 'OUTBOUND'::text) AND (outlet_id IS NOT NULL) AND (supplier_id IS NULL)))),
    CONSTRAINT tr_hub_cov_reference CHECK (((source_reference)::text ~ '\S'::text)),
    CONSTRAINT tr_hub_cov_source_candidate CHECK (((((source)::text = 'SYNTHETIC/UAT'::text) AND ((uat_candidate_code)::text ~ '^[0-9a-f]{32}$'::text)) OR (((source)::text = ANY (ARRAY[('PROVIDER_CONFIRMED_IMPORT'::character varying)::text, ('PROVIDER_PORTAL'::character varying)::text])) AND ((uat_candidate_code)::text = ''::text)))),
    CONSTRAINT tr_hub_cov_valid_period CHECK ((valid_from <= valid_through))
);


--
-- Name: hub_coverage_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.hub_coverage_evidence ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.hub_coverage_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: hubs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hubs (
    id bigint NOT NULL,
    hub_code character varying(30) NOT NULL,
    hub_name character varying(150) NOT NULL,
    address text NOT NULL,
    is_active boolean NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: hubs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.hubs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.hubs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_balances (
    id bigint NOT NULL,
    scenario character varying(50) NOT NULL,
    on_hand_kg numeric(14,3) NOT NULL,
    reserved_kg numeric(14,3) NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    supplier_item_id bigint NOT NULL,
    CONSTRAINT ck_cp11_stock_available CHECK (((on_hand_kg >= reserved_kg) AND (reserved_kg >= (0)::numeric)))
);


--
-- Name: inventory_balances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.inventory_balances ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.inventory_balances_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_reservations (
    id bigint NOT NULL,
    held_kg numeric(14,3) NOT NULL,
    remaining_kg numeric(14,3) NOT NULL,
    balance_id bigint NOT NULL,
    promise_id bigint NOT NULL,
    CONSTRAINT ck_cp11_stock_reservation CHECK (((held_kg > (0)::numeric) AND (held_kg >= remaining_kg) AND (remaining_kg >= (0)::numeric)))
);


--
-- Name: inventory_reservations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.inventory_reservations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.inventory_reservations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inventory_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_transactions (
    id bigint NOT NULL,
    request_id uuid,
    kind character varying(16) NOT NULL,
    on_hand_delta_kg numeric(14,3) NOT NULL,
    reserved_delta_kg numeric(14,3) NOT NULL,
    reason character varying(500) NOT NULL,
    source_reference character varying(200) NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    actor_id bigint NOT NULL,
    event_id bigint,
    balance_id bigint NOT NULL,
    reservation_id bigint
);


--
-- Name: inventory_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.inventory_transactions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.inventory_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id bigint NOT NULL,
    item_code character varying(30) NOT NULL,
    item_name character varying(200) NOT NULL,
    weight_unit character varying(10) NOT NULL,
    item_description text,
    is_active boolean NOT NULL,
    cargo_category_id bigint NOT NULL
);


--
-- Name: items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: logistics_execution_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logistics_execution_events (
    id bigint NOT NULL,
    request_id uuid NOT NULL,
    wave integer NOT NULL,
    stop integer NOT NULL,
    action character varying(32) NOT NULL,
    quantities jsonb NOT NULL,
    reason character varying(500) NOT NULL,
    exception_code character varying(40) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    provenance character varying(32) NOT NULL,
    actor_id bigint NOT NULL,
    demand_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    CONSTRAINT ck_cp11_execution_stop CHECK (((stop > 0) AND (wave > 0))),
    CONSTRAINT logistics_execution_events_stop_check CHECK ((stop >= 0)),
    CONSTRAINT logistics_execution_events_wave_check CHECK ((wave >= 0))
);


--
-- Name: logistics_execution_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.logistics_execution_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.logistics_execution_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: logistics_fleet_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logistics_fleet_holds (
    id bigint NOT NULL,
    wave integer NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    evidence jsonb NOT NULL,
    released_at timestamp with time zone,
    offer_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    CONSTRAINT ck_cp11_wave_hold_window CHECK (((starts_at < ends_at) AND (wave > 0))),
    CONSTRAINT logistics_fleet_holds_wave_check CHECK ((wave >= 0))
);


--
-- Name: logistics_fleet_holds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.logistics_fleet_holds ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.logistics_fleet_holds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: logistics_reconciliation_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logistics_reconciliation_records (
    id bigint NOT NULL,
    mode character varying(24) NOT NULL,
    action character varying(20) NOT NULL,
    request_id uuid NOT NULL,
    target character varying(140) NOT NULL,
    reason character varying(500) NOT NULL,
    evidence jsonb NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    actor_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    CONSTRAINT ck_cp12_action CHECK (((action)::text = ANY (ARRAY[('COST_SUBMIT'::character varying)::text, ('COST_APPROVE'::character varying)::text, ('COST_RETURN'::character varying)::text, ('ISSUE_REPORT'::character varying)::text, ('ISSUE_REQUEST'::character varying)::text, ('ISSUE_EVIDENCE'::character varying)::text, ('ISSUE_RESOLVE'::character varying)::text, ('CLOSE'::character varying)::text]))),
    CONSTRAINT ck_cp12_mode CHECK (((mode)::text = ANY (ARRAY[('COMMERCIAL_EXECUTION'::character varying)::text, ('SIMULATION'::character varying)::text, ('CAPSTONE'::character varying)::text]))),
    CONSTRAINT ck_cp12_reason CHECK ((NOT ((reason)::text = ''::text)))
);


--
-- Name: logistics_reconciliation_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.logistics_reconciliation_records ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.logistics_reconciliation_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operational_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operational_evidence (
    id bigint NOT NULL,
    kind character varying(20) NOT NULL,
    business_key character varying(64) NOT NULL,
    version integer NOT NULL,
    valid_from date NOT NULL,
    valid_to date NOT NULL,
    approval character varying(12) NOT NULL,
    provenance character varying(20) NOT NULL,
    scenario character varying(50) NOT NULL,
    source_reference character varying(95) NOT NULL,
    scope jsonb NOT NULL,
    data jsonb NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    recorded_by_id bigint NOT NULL,
    CONSTRAINT ck_ops_evidence_approval CHECK (((approval)::text = ANY (ARRAY[('REFERENCE'::character varying)::text, ('APPROVED'::character varying)::text, ('REVOKED'::character varying)::text]))),
    CONSTRAINT ck_ops_evidence_dates CHECK ((valid_from <= valid_to)),
    CONSTRAINT ck_ops_evidence_kind CHECK (((kind)::text = ANY (ARRAY[('CALENDAR'::character varying)::text, ('TRAVEL'::character varying)::text, ('SERVICE'::character varying)::text, ('HUB_HOURS'::character varying)::text, ('HUB_COVERAGE'::character varying)::text, ('QUOTE'::character varying)::text, ('HUB_FEE'::character varying)::text, ('BASELINE'::character varying)::text, ('POLICY'::character varying)::text, ('LOCATION'::character varying)::text, ('AVAILABILITY'::character varying)::text, ('TARIFF'::character varying)::text]))),
    CONSTRAINT ck_ops_evidence_provenance CHECK (((((provenance)::text = 'OPERATIONAL'::text) AND ((scenario)::text = ''::text)) OR (((provenance)::text = 'SYNTHETIC/CAPSTONE'::text) AND ((scenario)::text ~ '\S'::text)))),
    CONSTRAINT operational_evidence_version_check CHECK ((version >= 0))
);


--
-- Name: operational_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.operational_evidence ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.operational_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: outlets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outlets (
    id bigint NOT NULL,
    outlet_code character varying(30) NOT NULL,
    outlet_name character varying(200) NOT NULL,
    address text NOT NULL,
    contact_name character varying(150),
    phone character varying(30),
    is_active boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: outlets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.outlets ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.outlets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: plan_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_decisions (
    id bigint NOT NULL,
    request_id uuid NOT NULL,
    outcome character varying(24) NOT NULL,
    reason text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    actor_id bigint NOT NULL,
    evaluation_id bigint NOT NULL,
    group_id bigint NOT NULL,
    CONSTRAINT ck_plan_decision_outcome CHECK ((((outcome)::text = ANY (ARRAY[('APPROVE'::character varying)::text, ('REJECT'::character varying)::text, ('REQUEST_RECALCULATION'::character varying)::text])) AND (reason ~ '\S'::text)))
);


--
-- Name: plan_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.plan_decisions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.plan_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: planning_parameters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_parameters (
    id bigint NOT NULL,
    parameter_key character varying(100) NOT NULL,
    parameter_value jsonb NOT NULL,
    data_type character varying(20) NOT NULL,
    description text,
    updated_at timestamp with time zone NOT NULL,
    updated_by_id bigint
);


--
-- Name: planning_parameters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.planning_parameters ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.planning_parameters_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: planning_run_demands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_run_demands (
    id bigint NOT NULL,
    demand_snapshot jsonb NOT NULL,
    eligibility_status character varying(20) NOT NULL,
    primary_reason_code character varying(100),
    plan_guard_status character varying(20) NOT NULL,
    matching_status character varying(30) NOT NULL,
    diagnostics jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    demand_id bigint NOT NULL,
    planning_run_id bigint NOT NULL,
    CONSTRAINT ck_planning_run_demands_eligibility CHECK (((eligibility_status)::text = ANY (ARRAY[('NOT_EVALUATED'::character varying)::text, ('ELIGIBLE'::character varying)::text, ('EXCLUDED'::character varying)::text]))),
    CONSTRAINT ck_planning_run_demands_matching CHECK (((matching_status)::text = ANY (ARRAY[('NOT_EVALUATED'::character varying)::text, ('UNMATCHED'::character varying)::text, ('INCLUDED'::character varying)::text, ('MULTIPLE_CANDIDATES'::character varying)::text]))),
    CONSTRAINT ck_planning_run_demands_plan_guard CHECK (((plan_guard_status)::text = ANY (ARRAY[('PASS'::character varying)::text, ('CONFLICT'::character varying)::text, ('NOT_EVALUATED'::character varying)::text]))),
    CONSTRAINT ck_run_demands_diagnostics_array CHECK ((jsonb_typeof(diagnostics) = 'array'::text))
);


--
-- Name: planning_run_demands_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.planning_run_demands ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.planning_run_demands_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: planning_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_runs (
    id bigint NOT NULL,
    run_code uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    status character varying(20) NOT NULL,
    source_mode character varying(30) NOT NULL,
    scenario_tag character varying(50),
    source_reference character varying(255),
    parameters_snapshot jsonb NOT NULL,
    cost_profile_id bigint,
    initiated_by_id bigint NOT NULL,
    rule_set_id bigint NOT NULL,
    failure_diagnostics jsonb NOT NULL,
    CONSTRAINT ck_planning_runs_completion_time CHECK ((((completed_at IS NULL) AND ((status)::text = 'IN_PROGRESS'::text)) OR ((completed_at IS NOT NULL) AND ((status)::text = ANY (ARRAY[('COMPLETED'::character varying)::text, ('FAILED'::character varying)::text]))))),
    CONSTRAINT ck_planning_runs_failure_diag_array CHECK ((jsonb_typeof(failure_diagnostics) = 'array'::text)),
    CONSTRAINT ck_planning_runs_snapshot_object CHECK ((jsonb_typeof(parameters_snapshot) = 'object'::text)),
    CONSTRAINT ck_planning_runs_source_valid CHECK (((source_mode)::text = ANY (ARRAY[('SYNTHETIC'::character varying)::text, ('MANUAL'::character varying)::text, ('BATCH'::character varying)::text, ('API'::character varying)::text]))),
    CONSTRAINT ck_planning_runs_status_valid CHECK (((status)::text = ANY (ARRAY[('IN_PROGRESS'::character varying)::text, ('COMPLETED'::character varying)::text, ('FAILED'::character varying)::text])))
);


--
-- Name: planning_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.planning_runs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.planning_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: provider_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_availability (
    id bigint NOT NULL,
    service_date date NOT NULL,
    available_vehicle_count integer NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    availability_status character varying(12) NOT NULL,
    source_mode character varying(40) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    provider_vehicle_id bigint NOT NULL,
    CONSTRAINT provider_availability_available_vehicle_count_check CHECK ((available_vehicle_count >= 0)),
    CONSTRAINT tr_avail_status_count_match CHECK (((((availability_status)::text = 'AVAILABLE'::text) AND (available_vehicle_count > 0)) OR (((availability_status)::text = 'UNAVAILABLE'::text) AND (available_vehicle_count = 0)))),
    CONSTRAINT tr_avail_valid_time_window CHECK ((start_time < end_time))
);


--
-- Name: provider_availability_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.provider_availability ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.provider_availability_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: provider_supplier_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_supplier_coverage (
    id bigint NOT NULL,
    coverage_status character varying(10) NOT NULL,
    can_pickup boolean NOT NULL,
    service_note text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    provider_id bigint NOT NULL,
    supplier_id bigint NOT NULL
);


--
-- Name: provider_supplier_coverage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.provider_supplier_coverage ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.provider_supplier_coverage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: provider_vehicle_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_vehicle_offers (
    id bigint NOT NULL,
    available_vehicle_count integer NOT NULL,
    fuel_type character varying(20) NOT NULL,
    operating_start_time time without time zone,
    operating_end_time time without time zone,
    fixed_quote_vnd numeric(18,2),
    estimated_cost_per_km_vnd numeric(18,2),
    is_active boolean NOT NULL,
    vehicle_note text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    provider_id bigint NOT NULL,
    vehicle_type_id bigint NOT NULL,
    CONSTRAINT provider_vehicle_offers_available_vehicle_count_check CHECK ((available_vehicle_count >= 0)),
    CONSTRAINT tr_offer_active_capacity_positive CHECK (((NOT is_active) OR (available_vehicle_count > 0))),
    CONSTRAINT tr_offer_fixed_quote_nonneg CHECK (((fixed_quote_vnd IS NULL) OR (fixed_quote_vnd >= (0)::numeric))),
    CONSTRAINT tr_offer_km_cost_nonneg CHECK (((estimated_cost_per_km_vnd IS NULL) OR (estimated_cost_per_km_vnd >= (0)::numeric))),
    CONSTRAINT tr_offer_operating_hours_pair CHECK ((((operating_end_time IS NULL) AND (operating_start_time IS NULL)) OR ((operating_end_time IS NOT NULL) AND (operating_start_time IS NOT NULL) AND (operating_start_time < operating_end_time))))
);


--
-- Name: provider_vehicle_offers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.provider_vehicle_offers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.provider_vehicle_offers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receiving_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receiving_slots (
    id bigint NOT NULL,
    slot_date date NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    slot_type character varying(20) NOT NULL,
    status character varying(20) NOT NULL,
    reason text,
    source character varying(120) NOT NULL,
    source_reference character varying(255) NOT NULL,
    source_mode character varying(15) NOT NULL,
    outlet_id bigint NOT NULL,
    CONSTRAINT ck_receiving_slot_source CHECK ((((source_mode)::text = ANY (ARRAY[('OPERATIONAL'::character varying)::text, ('SYNTHETIC/UAT'::character varying)::text, ('SYNTHETIC_V7'::character varying)::text])) AND ((source)::text ~ '\S'::text) AND ((source_reference)::text ~ '\S'::text))),
    CONSTRAINT ck_receiving_slot_status CHECK (((status)::text = ANY (ARRAY[('OPEN'::character varying)::text, ('RESERVED'::character varying)::text, ('CONFIRMED'::character varying)::text, ('REJECTED'::character varying)::text, ('CANCELLED'::character varying)::text]))),
    CONSTRAINT ck_receiving_slot_times CHECK ((start_time < end_time)),
    CONSTRAINT ck_receiving_slot_type CHECK (((slot_type)::text = ANY (ARRAY[('BLOCKED'::character varying)::text, ('AVAILABLE'::character varying)::text])))
);


--
-- Name: receiving_slots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.receiving_slots ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.receiving_slots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receiving_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receiving_windows (
    id bigint NOT NULL,
    day_of_week smallint NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    is_active boolean NOT NULL,
    source character varying(120) NOT NULL,
    source_reference character varying(255) NOT NULL,
    source_mode character varying(15) NOT NULL,
    outlet_id bigint NOT NULL,
    CONSTRAINT ck_receiving_window_source CHECK ((((source_mode)::text = ANY (ARRAY[('OPERATIONAL'::character varying)::text, ('SYNTHETIC/UAT'::character varying)::text, ('SYNTHETIC_V7'::character varying)::text])) AND ((source)::text ~ '\S'::text) AND ((source_reference)::text ~ '\S'::text))),
    CONSTRAINT ck_receiving_window_times CHECK ((start_time < end_time)),
    CONSTRAINT ck_receiving_window_weekday CHECK ((day_of_week = ANY (ARRAY[0, 1, 2, 3, 4, 5, 6]))),
    CONSTRAINT receiving_windows_day_of_week_check CHECK ((day_of_week >= 0))
);


--
-- Name: receiving_windows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.receiving_windows ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.receiving_windows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id bigint NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(100) NOT NULL,
    description text NOT NULL,
    is_active boolean NOT NULL,
    CONSTRAINT accounts_role_valid_code CHECK (((code)::text = ANY (ARRAY[('PURCHASING_STAFF'::character varying)::text, ('SUPPLIER'::character varying)::text, ('TRANSPORT_PROVIDER'::character varying)::text, ('MANAGER'::character varying)::text])))
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.roles ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: rule_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rule_sets (
    id bigint NOT NULL,
    rule_set_code character varying(40) NOT NULL,
    rule_set_name character varying(150) NOT NULL,
    version_no integer NOT NULL,
    status character varying(20) NOT NULL,
    effective_from timestamp with time zone,
    created_by_id bigint NOT NULL,
    CONSTRAINT ck_rule_sets_status_valid CHECK (((status)::text = ANY (ARRAY[('DRAFT'::character varying)::text, ('ACTIVE'::character varying)::text, ('RETIRED'::character varying)::text]))),
    CONSTRAINT ck_rule_sets_version_positive CHECK ((version_no > 0)),
    CONSTRAINT rule_sets_version_no_check CHECK ((version_no >= 0))
);


--
-- Name: rule_sets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.rule_sets ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.rule_sets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supplier_confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_confirmations (
    id bigint NOT NULL,
    confirmation_status character varying(20) NOT NULL,
    source_mode character varying(20) NOT NULL,
    ready_date date,
    ready_start_time time without time zone,
    ready_end_time time without time zone,
    pickup_address text,
    recorded_at timestamp with time zone,
    confirmation_note text NOT NULL,
    commitment_released_at timestamp with time zone,
    commitment_release_note text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    commitment_released_by_id bigint,
    demand_id bigint NOT NULL,
    supplier_id bigint NOT NULL,
    CONSTRAINT sc_ready_time_valid CHECK ((((ready_end_time IS NULL) AND (ready_start_time IS NULL)) OR ((ready_end_time IS NOT NULL) AND (ready_start_time IS NOT NULL) AND (ready_start_time < ready_end_time)))),
    CONSTRAINT sc_release_positive_commitment CHECK (((commitment_released_at IS NULL) OR ((confirmation_status)::text = ANY (ARRAY[('PARTIAL'::character varying)::text, ('CONFIRMED'::character varying)::text])))),
    CONSTRAINT sc_source_mode_valid CHECK (((source_mode)::text = ANY (ARRAY[('LIVE_API'::character varying)::text, ('SYNTHETIC_V7'::character varying)::text, ('SYNTHETIC_CAPSTONE'::character varying)::text, ('LEGACY_IMPORT'::character varying)::text, ('MANUAL_ENTRY'::character varying)::text]))),
    CONSTRAINT sc_status_valid CHECK (((confirmation_status)::text = ANY (ARRAY[('NOT_REQUESTED'::character varying)::text, ('PENDING'::character varying)::text, ('CONFIRMED'::character varying)::text, ('PARTIAL'::character varying)::text, ('DECLINED'::character varying)::text])))
);


--
-- Name: supplier_confirmations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supplier_confirmations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.supplier_confirmations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supplier_item_promises; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_item_promises (
    id bigint NOT NULL,
    promised_weight_kg numeric(12,3) NOT NULL,
    confirmed_weight_kg numeric(12,3) NOT NULL,
    line_status character varying(12) NOT NULL,
    unit_price_vnd_per_kg_snapshot numeric(18,2) NOT NULL,
    lead_time_hours_snapshot integer,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    demand_item_id bigint NOT NULL,
    supplier_item_id bigint NOT NULL,
    supplier_request_id bigint NOT NULL,
    decline_reason text NOT NULL,
    CONSTRAINT sip_confirmed_in_range CHECK (((confirmed_weight_kg >= (0)::numeric) AND (confirmed_weight_kg <= promised_weight_kg))),
    CONSTRAINT sip_lead_nonnegative CHECK (((lead_time_hours_snapshot IS NULL) OR (lead_time_hours_snapshot >= 0))),
    CONSTRAINT sip_line_status_consistent CHECK ((((confirmed_weight_kg = (0)::numeric) AND ((line_status)::text = 'PENDING'::text)) OR ((confirmed_weight_kg = (0)::numeric) AND ((line_status)::text = 'DECLINED'::text)) OR ((confirmed_weight_kg = promised_weight_kg) AND ((line_status)::text = 'CONFIRMED'::text)) OR ((confirmed_weight_kg > (0)::numeric) AND (confirmed_weight_kg < promised_weight_kg) AND ((line_status)::text = 'PARTIAL'::text)))),
    CONSTRAINT sip_price_nonnegative CHECK ((unit_price_vnd_per_kg_snapshot >= (0)::numeric)),
    CONSTRAINT sip_promised_positive CHECK ((promised_weight_kg > (0)::numeric))
);


--
-- Name: supplier_item_promises_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supplier_item_promises ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.supplier_item_promises_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supplier_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_items (
    id bigint NOT NULL,
    unit_price_vnd_per_kg numeric(18,2) NOT NULL,
    max_daily_supply_kg numeric(12,3),
    lead_time_hours integer,
    minimum_order_kg numeric(12,3),
    offer_status character varying(20) NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    item_id bigint NOT NULL,
    supplier_id bigint NOT NULL,
    CONSTRAINT md_sitem_daily_positive_if_set CHECK (((max_daily_supply_kg IS NULL) OR (max_daily_supply_kg > (0)::numeric))),
    CONSTRAINT md_sitem_lead_nonnegative CHECK (((lead_time_hours IS NULL) OR (lead_time_hours >= 0))),
    CONSTRAINT md_sitem_min_nonnegative CHECK (((minimum_order_kg IS NULL) OR (minimum_order_kg >= (0)::numeric))),
    CONSTRAINT md_sitem_offer_status_valid CHECK (((offer_status)::text = ANY (ARRAY[('ACTIVE'::character varying)::text, ('INACTIVE'::character varying)::text]))),
    CONSTRAINT md_sitem_price_nonnegative CHECK ((unit_price_vnd_per_kg >= (0)::numeric))
);


--
-- Name: supplier_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supplier_items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.supplier_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supplier_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_requests (
    id bigint NOT NULL,
    request_code character varying(50) NOT NULL,
    attempt_no smallint NOT NULL,
    request_status character varying(12) NOT NULL,
    sent_at timestamp with time zone NOT NULL,
    responded_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by_id bigint NOT NULL,
    demand_id bigint NOT NULL,
    supplier_id bigint NOT NULL,
    supplier_confirmation_id bigint NOT NULL,
    CONSTRAINT sr_attempt_positive CHECK ((attempt_no > 0)),
    CONSTRAINT sr_response_timestamp_valid CHECK (((((request_status)::text = 'RESPONDED'::text) AND (responded_at IS NOT NULL)) OR (((request_status)::text = ANY (ARRAY[('WAITING'::character varying)::text, ('EXPIRED'::character varying)::text])) AND (responded_at IS NULL)) OR ((request_status)::text = 'CANCELLED'::text))),
    CONSTRAINT sr_status_valid CHECK (((request_status)::text = ANY (ARRAY[('WAITING'::character varying)::text, ('RESPONDED'::character varying)::text, ('EXPIRED'::character varying)::text, ('CANCELLED'::character varying)::text]))),
    CONSTRAINT supplier_requests_attempt_no_check CHECK ((attempt_no >= 0))
);


--
-- Name: supplier_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supplier_requests ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.supplier_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id bigint NOT NULL,
    supplier_code character varying(30) NOT NULL,
    supplier_name character varying(200) NOT NULL,
    contact_name character varying(150),
    phone character varying(30),
    email character varying(254),
    address text,
    is_active boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: suppliers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.suppliers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.suppliers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transport_handover_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_handover_responses (
    id bigint NOT NULL,
    outcome character varying(8) NOT NULL,
    reason text NOT NULL,
    responded_at timestamp with time zone NOT NULL,
    actor_id bigint NOT NULL,
    handover_id bigint NOT NULL,
    CONSTRAINT ck_transport_handover_reply CHECK ((((outcome)::text = ANY (ARRAY[('CONFIRM'::character varying)::text, ('DECLINE'::character varying)::text])) AND (reason ~ '\S'::text)))
);


--
-- Name: transport_handover_responses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transport_handover_responses ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transport_handover_responses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transport_handovers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_handovers (
    id bigint NOT NULL,
    sent_at timestamp with time zone NOT NULL,
    actor_id bigint NOT NULL,
    plan_id bigint NOT NULL
);


--
-- Name: transport_handovers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transport_handovers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transport_handovers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transport_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_providers (
    id bigint NOT NULL,
    provider_code character varying(30) NOT NULL,
    provider_name character varying(200) NOT NULL,
    provider_type character varying(30) NOT NULL,
    service_region text NOT NULL,
    contact_email character varying(254) NOT NULL,
    is_active boolean NOT NULL
);


--
-- Name: transport_providers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transport_providers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transport_providers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_outlet_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_outlet_access (
    id bigint NOT NULL,
    is_active boolean NOT NULL,
    assigned_at timestamp with time zone NOT NULL,
    assigned_by_id bigint,
    outlet_id bigint NOT NULL,
    user_id bigint NOT NULL
);


--
-- Name: user_outlet_access_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_outlet_access ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_outlet_access_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id bigint NOT NULL,
    assigned_at timestamp with time zone NOT NULL,
    assigned_by_id bigint,
    role_id bigint NOT NULL,
    user_id bigint NOT NULL,
    is_active boolean NOT NULL,
    CONSTRAINT acc_userrole_no_self_assign CHECK (((assigned_by_id IS NULL) OR (NOT ((assigned_by_id = user_id) AND (assigned_by_id IS NOT NULL)))))
);


--
-- Name: user_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    password character varying(128) NOT NULL,
    is_superuser boolean NOT NULL,
    email character varying(254) NOT NULL,
    full_name character varying(255) NOT NULL,
    is_active boolean NOT NULL,
    is_staff boolean NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    capstone_scenario character varying(50) NOT NULL,
    CONSTRAINT accounts_user_email_lowercase CHECK (((email)::text = lower((email)::text)))
);


--
-- Name: users_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users_groups (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    group_id integer NOT NULL
);


--
-- Name: users_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.users_groups ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.users_groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: users_user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users_user_permissions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    permission_id integer NOT NULL
);


--
-- Name: users_user_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.users_user_permissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.users_user_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: vehicle_cargo_compatibility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_cargo_compatibility (
    is_supported boolean NOT NULL,
    source character varying(50),
    cargo_category_id bigint NOT NULL,
    vehicle_type_id bigint NOT NULL
);


--
-- Name: vehicle_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_types (
    id bigint NOT NULL,
    vehicle_code character varying(30) NOT NULL,
    vehicle_name character varying(150) NOT NULL,
    capacity_kg numeric(12,3) NOT NULL,
    description text,
    is_active boolean NOT NULL,
    CONSTRAINT md_vtype_capacity_positive CHECK ((capacity_kg > (0)::numeric))
);


--
-- Name: vehicle_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.vehicle_types ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.vehicle_types_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wave_demands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wave_demands (
    allocated_quantity_kg numeric(12,3) NOT NULL,
    demand_id bigint NOT NULL,
    wave_id bigint NOT NULL,
    CONSTRAINT ck_wave_demand_quantity CHECK ((allocated_quantity_kg > (0)::numeric))
);


--
-- Name: external_user_access acc_ext_access_user_type_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_user_access
    ADD CONSTRAINT acc_ext_access_user_type_uniq UNIQUE (user_id, actor_type);


--
-- Name: user_outlet_access acc_user_outlet_access_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_outlet_access
    ADD CONSTRAINT acc_user_outlet_access_uniq UNIQUE (user_id, outlet_id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_group auth_group_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group
    ADD CONSTRAINT auth_group_name_key UNIQUE (name);


--
-- Name: auth_group_permissions auth_group_permissions_group_id_permission_id_0cd325b0_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_group_id_permission_id_0cd325b0_uniq UNIQUE (group_id, permission_id);


--
-- Name: auth_group_permissions auth_group_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_pkey PRIMARY KEY (id);


--
-- Name: auth_group auth_group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group
    ADD CONSTRAINT auth_group_pkey PRIMARY KEY (id);


--
-- Name: auth_permission auth_permission_content_type_id_codename_01ab375a_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_content_type_id_codename_01ab375a_uniq UNIQUE (content_type_id, codename);


--
-- Name: auth_permission auth_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_pkey PRIMARY KEY (id);


--
-- Name: authtoken_token authtoken_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authtoken_token
    ADD CONSTRAINT authtoken_token_pkey PRIMARY KEY (key);


--
-- Name: authtoken_token authtoken_token_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authtoken_token
    ADD CONSTRAINT authtoken_token_user_id_key UNIQUE (user_id);


--
-- Name: business_rules business_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_rules
    ADD CONSTRAINT business_rules_pkey PRIMARY KEY (id);


--
-- Name: cargo_categories cargo_categories_category_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cargo_categories
    ADD CONSTRAINT cargo_categories_category_code_key UNIQUE (category_code);


--
-- Name: cargo_categories cargo_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cargo_categories
    ADD CONSTRAINT cargo_categories_pkey PRIMARY KEY (id);


--
-- Name: collaboration_groups collaboration_groups_group_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_groups
    ADD CONSTRAINT collaboration_groups_group_code_key UNIQUE (group_code);


--
-- Name: collaboration_groups collaboration_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_groups
    ADD CONSTRAINT collaboration_groups_pkey PRIMARY KEY (id);


--
-- Name: cost_allocations cost_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_pkey PRIMARY KEY (id);


--
-- Name: cost_components cost_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_components
    ADD CONSTRAINT cost_components_pkey PRIMARY KEY (id);


--
-- Name: cost_profiles cost_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_profiles
    ADD CONSTRAINT cost_profiles_pkey PRIMARY KEY (id);


--
-- Name: cost_profiles cost_profiles_profile_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_profiles
    ADD CONSTRAINT cost_profiles_profile_code_key UNIQUE (profile_code);


--
-- Name: delivery_demands delivery_demands_demand_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_demands
    ADD CONSTRAINT delivery_demands_demand_code_key UNIQUE (demand_code);


--
-- Name: delivery_demands delivery_demands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_demands
    ADD CONSTRAINT delivery_demands_pkey PRIMARY KEY (id);


--
-- Name: delivery_waves delivery_waves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_waves
    ADD CONSTRAINT delivery_waves_pkey PRIMARY KEY (id);


--
-- Name: demand_cost_inputs demand_cost_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_cost_inputs
    ADD CONSTRAINT demand_cost_inputs_pkey PRIMARY KEY (id);


--
-- Name: demand_items demand_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_items
    ADD CONSTRAINT demand_items_pkey PRIMARY KEY (id);


--
-- Name: demand_sourcing_options demand_sourcing_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_sourcing_options
    ADD CONSTRAINT demand_sourcing_options_pkey PRIMARY KEY (id);


--
-- Name: demand_supplier_selections demand_supplier_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_supplier_selections
    ADD CONSTRAINT demand_supplier_selections_pkey PRIMARY KEY (id);


--
-- Name: demand_items di_demand_item_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_items
    ADD CONSTRAINT di_demand_item_uniq UNIQUE (demand_id, item_id);


--
-- Name: django_admin_log django_admin_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_pkey PRIMARY KEY (id);


--
-- Name: django_content_type django_content_type_app_label_model_76bd3d3b_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_content_type
    ADD CONSTRAINT django_content_type_app_label_model_76bd3d3b_uniq UNIQUE (app_label, model);


--
-- Name: django_content_type django_content_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_content_type
    ADD CONSTRAINT django_content_type_pkey PRIMARY KEY (id);


--
-- Name: django_migrations django_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_migrations
    ADD CONSTRAINT django_migrations_pkey PRIMARY KEY (id);


--
-- Name: django_session django_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_session
    ADD CONSTRAINT django_session_pkey PRIMARY KEY (session_key);


--
-- Name: demand_sourcing_options dso_demand_offer_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_sourcing_options
    ADD CONSTRAINT dso_demand_offer_uniq UNIQUE (demand_item_id, supplier_item_id);


--
-- Name: demand_supplier_selections dss_demand_selection_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_supplier_selections
    ADD CONSTRAINT dss_demand_selection_uniq UNIQUE (demand_id, selection_no);


--
-- Name: economic_evaluations economic_evaluations_evaluation_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economic_evaluations
    ADD CONSTRAINT economic_evaluations_evaluation_code_key UNIQUE (evaluation_code);


--
-- Name: economic_evaluations economic_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economic_evaluations
    ADD CONSTRAINT economic_evaluations_pkey PRIMARY KEY (id);


--
-- Name: external_user_access external_user_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_user_access
    ADD CONSTRAINT external_user_access_pkey PRIMARY KEY (id);


--
-- Name: f3_evaluations f3_evaluations_evaluation_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f3_evaluations
    ADD CONSTRAINT f3_evaluations_evaluation_code_key UNIQUE (evaluation_code);


--
-- Name: f3_evaluations f3_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f3_evaluations
    ADD CONSTRAINT f3_evaluations_pkey PRIMARY KEY (id);


--
-- Name: f4_evaluations f4_evaluations_evaluation_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f4_evaluations
    ADD CONSTRAINT f4_evaluations_evaluation_code_key UNIQUE (evaluation_code);


--
-- Name: f4_evaluations f4_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f4_evaluations
    ADD CONSTRAINT f4_evaluations_pkey PRIMARY KEY (id);


--
-- Name: final_plan_demands final_plan_demands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plan_demands
    ADD CONSTRAINT final_plan_demands_pkey PRIMARY KEY (demand_id);


--
-- Name: final_plans final_plans_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT final_plans_code_key UNIQUE (code);


--
-- Name: final_plans final_plans_decision_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT final_plans_decision_id_key UNIQUE (decision_id);


--
-- Name: final_plans final_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT final_plans_pkey PRIMARY KEY (id);


--
-- Name: final_plans final_plans_supersedes_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT final_plans_supersedes_id_key UNIQUE (supersedes_id);


--
-- Name: fulfillment_plans fulfillment_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_plans
    ADD CONSTRAINT fulfillment_plans_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_plans fulfillment_plans_plan_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_plans
    ADD CONSTRAINT fulfillment_plans_plan_code_key UNIQUE (plan_code);


--
-- Name: group_demands group_demands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_demands
    ADD CONSTRAINT group_demands_pkey PRIMARY KEY (group_id, demand_id);


--
-- Name: hub_coverage_evidence hub_coverage_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_coverage_evidence
    ADD CONSTRAINT hub_coverage_evidence_pkey PRIMARY KEY (id);


--
-- Name: hubs hubs_hub_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hubs
    ADD CONSTRAINT hubs_hub_code_key UNIQUE (hub_code);


--
-- Name: hubs hubs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hubs
    ADD CONSTRAINT hubs_pkey PRIMARY KEY (id);


--
-- Name: inventory_balances inventory_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balances
    ADD CONSTRAINT inventory_balances_pkey PRIMARY KEY (id);


--
-- Name: inventory_reservations inventory_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_reservations
    ADD CONSTRAINT inventory_reservations_pkey PRIMARY KEY (id);


--
-- Name: inventory_reservations inventory_reservations_promise_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_reservations
    ADD CONSTRAINT inventory_reservations_promise_id_key UNIQUE (promise_id);


--
-- Name: inventory_transactions inventory_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_pkey PRIMARY KEY (id);


--
-- Name: items items_item_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_item_code_key UNIQUE (item_code);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: logistics_execution_events logistics_execution_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_execution_events
    ADD CONSTRAINT logistics_execution_events_pkey PRIMARY KEY (id);


--
-- Name: logistics_fleet_holds logistics_fleet_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_fleet_holds
    ADD CONSTRAINT logistics_fleet_holds_pkey PRIMARY KEY (id);


--
-- Name: logistics_reconciliation_records logistics_reconciliation_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_reconciliation_records
    ADD CONSTRAINT logistics_reconciliation_records_pkey PRIMARY KEY (id);


--
-- Name: supplier_items md_sitem_pair_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_items
    ADD CONSTRAINT md_sitem_pair_uniq UNIQUE (supplier_id, item_id);


--
-- Name: operational_evidence operational_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_evidence
    ADD CONSTRAINT operational_evidence_pkey PRIMARY KEY (id);


--
-- Name: outlets outlets_outlet_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outlets
    ADD CONSTRAINT outlets_outlet_code_key UNIQUE (outlet_code);


--
-- Name: outlets outlets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outlets
    ADD CONSTRAINT outlets_pkey PRIMARY KEY (id);


--
-- Name: plan_decisions plan_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_decisions
    ADD CONSTRAINT plan_decisions_pkey PRIMARY KEY (id);


--
-- Name: planning_parameters planning_parameters_parameter_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_parameters
    ADD CONSTRAINT planning_parameters_parameter_key_key UNIQUE (parameter_key);


--
-- Name: planning_parameters planning_parameters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_parameters
    ADD CONSTRAINT planning_parameters_pkey PRIMARY KEY (id);


--
-- Name: planning_run_demands planning_run_demands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_run_demands
    ADD CONSTRAINT planning_run_demands_pkey PRIMARY KEY (id);


--
-- Name: planning_runs planning_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_runs
    ADD CONSTRAINT planning_runs_pkey PRIMARY KEY (id);


--
-- Name: planning_runs planning_runs_run_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_runs
    ADD CONSTRAINT planning_runs_run_code_key UNIQUE (run_code);


--
-- Name: provider_availability provider_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability
    ADD CONSTRAINT provider_availability_pkey PRIMARY KEY (id);


--
-- Name: provider_supplier_coverage provider_supplier_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_supplier_coverage
    ADD CONSTRAINT provider_supplier_coverage_pkey PRIMARY KEY (id);


--
-- Name: provider_vehicle_offers provider_vehicle_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_vehicle_offers
    ADD CONSTRAINT provider_vehicle_offers_pkey PRIMARY KEY (id);


--
-- Name: receiving_slots receiving_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_slots
    ADD CONSTRAINT receiving_slots_pkey PRIMARY KEY (id);


--
-- Name: receiving_windows receiving_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_windows
    ADD CONSTRAINT receiving_windows_pkey PRIMARY KEY (id);


--
-- Name: roles roles_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_code_key UNIQUE (code);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: rule_sets rule_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rule_sets
    ADD CONSTRAINT rule_sets_pkey PRIMARY KEY (id);


--
-- Name: rule_sets rule_sets_rule_set_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rule_sets
    ADD CONSTRAINT rule_sets_rule_set_code_key UNIQUE (rule_set_code);


--
-- Name: supplier_item_promises sip_request_ditem_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_item_promises
    ADD CONSTRAINT sip_request_ditem_uniq UNIQUE (supplier_request_id, demand_item_id);


--
-- Name: supplier_requests sr_demand_attempt_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT sr_demand_attempt_uniq UNIQUE (demand_id, attempt_no);


--
-- Name: supplier_confirmations supplier_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_confirmations
    ADD CONSTRAINT supplier_confirmations_pkey PRIMARY KEY (id);


--
-- Name: supplier_item_promises supplier_item_promises_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_item_promises
    ADD CONSTRAINT supplier_item_promises_pkey PRIMARY KEY (id);


--
-- Name: supplier_items supplier_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_items
    ADD CONSTRAINT supplier_items_pkey PRIMARY KEY (id);


--
-- Name: supplier_requests supplier_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT supplier_requests_pkey PRIMARY KEY (id);


--
-- Name: supplier_requests supplier_requests_request_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT supplier_requests_request_code_key UNIQUE (request_code);


--
-- Name: supplier_requests supplier_requests_supplier_confirmation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT supplier_requests_supplier_confirmation_id_key UNIQUE (supplier_confirmation_id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_supplier_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_supplier_code_key UNIQUE (supplier_code);


--
-- Name: provider_supplier_coverage tr_cov_provider_supplier_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_supplier_coverage
    ADD CONSTRAINT tr_cov_provider_supplier_uq UNIQUE (provider_id, supplier_id);


--
-- Name: hub_coverage_evidence tr_hub_cov_evidence_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_coverage_evidence
    ADD CONSTRAINT tr_hub_cov_evidence_unique UNIQUE NULLS NOT DISTINCT (provider_id, hub_id, direction, supplier_id, outlet_id, source, uat_candidate_code, valid_from, valid_through, confirmation_status, source_reference);


--
-- Name: provider_vehicle_offers tr_offer_provider_vehicle_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_vehicle_offers
    ADD CONSTRAINT tr_offer_provider_vehicle_uq UNIQUE (provider_id, vehicle_type_id);


--
-- Name: transport_handover_responses transport_handover_responses_handover_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handover_responses
    ADD CONSTRAINT transport_handover_responses_handover_id_key UNIQUE (handover_id);


--
-- Name: transport_handover_responses transport_handover_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handover_responses
    ADD CONSTRAINT transport_handover_responses_pkey PRIMARY KEY (id);


--
-- Name: transport_handovers transport_handovers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handovers
    ADD CONSTRAINT transport_handovers_pkey PRIMARY KEY (id);


--
-- Name: transport_handovers transport_handovers_plan_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handovers
    ADD CONSTRAINT transport_handovers_plan_id_key UNIQUE (plan_id);


--
-- Name: transport_providers transport_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_providers
    ADD CONSTRAINT transport_providers_pkey PRIMARY KEY (id);


--
-- Name: transport_providers transport_providers_provider_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_providers
    ADD CONSTRAINT transport_providers_provider_code_key UNIQUE (provider_code);


--
-- Name: business_rules uq_business_rules_set_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_rules
    ADD CONSTRAINT uq_business_rules_set_code UNIQUE (rule_set_id, rule_code);


--
-- Name: logistics_execution_events uq_cp11_execution_request; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_execution_events
    ADD CONSTRAINT uq_cp11_execution_request UNIQUE (actor_id, request_id);


--
-- Name: inventory_transactions uq_cp11_ledger_request; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT uq_cp11_ledger_request UNIQUE (actor_id, request_id);


--
-- Name: inventory_balances uq_cp11_stock_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balances
    ADD CONSTRAINT uq_cp11_stock_scope UNIQUE (supplier_item_id, scenario);


--
-- Name: logistics_fleet_holds uq_cp11_wave_hold; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_fleet_holds
    ADD CONSTRAINT uq_cp11_wave_hold UNIQUE (plan_id, wave);


--
-- Name: logistics_reconciliation_records uq_cp12_actor_request; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_reconciliation_records
    ADD CONSTRAINT uq_cp12_actor_request UNIQUE (actor_id, request_id);


--
-- Name: delivery_waves uq_delivery_wave_plan_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_waves
    ADD CONSTRAINT uq_delivery_wave_plan_number UNIQUE (plan_id, wave_no);


--
-- Name: f3_evaluations uq_f3_evaluation_fingerprint; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f3_evaluations
    ADD CONSTRAINT uq_f3_evaluation_fingerprint UNIQUE (plan_id, contract_version, input_fingerprint, configuration_fingerprint);


--
-- Name: f4_evaluations uq_f4_evaluation_fingerprint; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f4_evaluations
    ADD CONSTRAINT uq_f4_evaluation_fingerprint UNIQUE (f3_evaluation_id, contract_version, input_fingerprint, configuration_fingerprint);


--
-- Name: cost_allocations uq_f5_allocation_outlet; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT uq_f5_allocation_outlet UNIQUE (evaluation_id, outlet_id);


--
-- Name: cost_components uq_f5_component_ordinal; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_components
    ADD CONSTRAINT uq_f5_component_ordinal UNIQUE (evaluation_id, ordinal);


--
-- Name: demand_cost_inputs uq_f5_cost_input_demand; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_cost_inputs
    ADD CONSTRAINT uq_f5_cost_input_demand UNIQUE (evaluation_id, demand_id);


--
-- Name: economic_evaluations uq_f5_evaluation_fingerprint; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economic_evaluations
    ADD CONSTRAINT uq_f5_evaluation_fingerprint UNIQUE (f4_evaluation_id, contract_version, input_fingerprint, configuration_fingerprint);


--
-- Name: final_plans uq_final_plan_scope_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT uq_final_plan_scope_version UNIQUE (scope_key, version);


--
-- Name: operational_evidence uq_ops_evidence_revision; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_evidence
    ADD CONSTRAINT uq_ops_evidence_revision UNIQUE (kind, business_key, provenance, scenario, version);


--
-- Name: plan_decisions uq_plan_decision_request; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_decisions
    ADD CONSTRAINT uq_plan_decision_request UNIQUE (actor_id, request_id);


--
-- Name: planning_run_demands uq_planning_run_demands_run_demand; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_run_demands
    ADD CONSTRAINT uq_planning_run_demands_run_demand UNIQUE (planning_run_id, demand_id);


--
-- Name: receiving_slots uq_receiving_slot_interval; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_slots
    ADD CONSTRAINT uq_receiving_slot_interval UNIQUE (outlet_id, slot_date, start_time, end_time, slot_type, source_mode);


--
-- Name: receiving_windows uq_receiving_window_interval; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_windows
    ADD CONSTRAINT uq_receiving_window_interval UNIQUE (outlet_id, day_of_week, start_time, end_time, source_mode);


--
-- Name: user_outlet_access user_outlet_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_outlet_access
    ADD CONSTRAINT user_outlet_access_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users_groups users_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_groups
    ADD CONSTRAINT users_groups_pkey PRIMARY KEY (id);


--
-- Name: users_groups users_groups_user_id_group_id_fc7788e8_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_groups
    ADD CONSTRAINT users_groups_user_id_group_id_fc7788e8_uniq UNIQUE (user_id, group_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users_user_permissions users_user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_user_permissions
    ADD CONSTRAINT users_user_permissions_pkey PRIMARY KEY (id);


--
-- Name: users_user_permissions users_user_permissions_user_id_permission_id_3b86cbdf_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_user_permissions
    ADD CONSTRAINT users_user_permissions_user_id_permission_id_3b86cbdf_uniq UNIQUE (user_id, permission_id);


--
-- Name: vehicle_cargo_compatibility vehicle_cargo_compatibility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_cargo_compatibility
    ADD CONSTRAINT vehicle_cargo_compatibility_pkey PRIMARY KEY (vehicle_type_id, cargo_category_id);


--
-- Name: vehicle_types vehicle_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_types
    ADD CONSTRAINT vehicle_types_pkey PRIMARY KEY (id);


--
-- Name: vehicle_types vehicle_types_vehicle_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_types
    ADD CONSTRAINT vehicle_types_vehicle_code_key UNIQUE (vehicle_code);


--
-- Name: wave_demands wave_demands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wave_demands
    ADD CONSTRAINT wave_demands_pkey PRIMARY KEY (wave_id, demand_id);


--
-- Name: acc_audit_actor_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_audit_actor_time_idx ON public.audit_logs USING btree (actor_user_id, created_at);


--
-- Name: acc_audit_entity_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_audit_entity_time_idx ON public.audit_logs USING btree (entity_type, entity_id, created_at);


--
-- Name: acc_userrole_role_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_userrole_role_user_idx ON public.user_roles USING btree (role_id, user_id);


--
-- Name: acc_userrole_user_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_userrole_user_uniq ON public.user_roles USING btree (user_id) WHERE is_active;


--
-- Name: auth_group_name_a6ea08ec_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_group_name_a6ea08ec_like ON public.auth_group USING btree (name varchar_pattern_ops);


--
-- Name: auth_group_permissions_group_id_b120cbf9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_group_permissions_group_id_b120cbf9 ON public.auth_group_permissions USING btree (group_id);


--
-- Name: auth_group_permissions_permission_id_84c5c92e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_group_permissions_permission_id_84c5c92e ON public.auth_group_permissions USING btree (permission_id);


--
-- Name: auth_permission_content_type_id_2f476e4b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_permission_content_type_id_2f476e4b ON public.auth_permission USING btree (content_type_id);


--
-- Name: authtoken_token_key_10f0b77e_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authtoken_token_key_10f0b77e_like ON public.authtoken_token USING btree (key varchar_pattern_ops);


--
-- Name: cargo_categories_category_code_969bd70f_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cargo_categories_category_code_969bd70f_like ON public.cargo_categories USING btree (category_code varchar_pattern_ops);


--
-- Name: collaboration_groups_created_by_id_73b1ce89; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collaboration_groups_created_by_id_73b1ce89 ON public.collaboration_groups USING btree (created_by_id);


--
-- Name: collaboration_groups_group_code_0a69324b_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collaboration_groups_group_code_0a69324b_like ON public.collaboration_groups USING btree (group_code varchar_pattern_ops);


--
-- Name: cost_allocations_evaluation_id_0b0d32bd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_allocations_evaluation_id_0b0d32bd ON public.cost_allocations USING btree (evaluation_id);


--
-- Name: cost_allocations_outlet_id_3ae334b8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_allocations_outlet_id_3ae334b8 ON public.cost_allocations USING btree (outlet_id);


--
-- Name: cost_components_delivery_wave_id_9456ed1a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_components_delivery_wave_id_9456ed1a ON public.cost_components USING btree (delivery_wave_id);


--
-- Name: cost_components_evaluation_id_25f94fbe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_components_evaluation_id_25f94fbe ON public.cost_components USING btree (evaluation_id);


--
-- Name: cost_profiles_profile_code_ca6c6332_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_profiles_profile_code_ca6c6332_like ON public.cost_profiles USING btree (profile_code varchar_pattern_ops);


--
-- Name: delivery_demands_capstone_scenario_eb46d098; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_demands_capstone_scenario_eb46d098 ON public.delivery_demands USING btree (capstone_scenario);


--
-- Name: delivery_demands_capstone_scenario_eb46d098_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_demands_capstone_scenario_eb46d098_like ON public.delivery_demands USING btree (capstone_scenario varchar_pattern_ops);


--
-- Name: delivery_demands_cargo_category_id_338ab084; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_demands_cargo_category_id_338ab084 ON public.delivery_demands USING btree (cargo_category_id);


--
-- Name: delivery_demands_created_by_id_5aaf9c9c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_demands_created_by_id_5aaf9c9c ON public.delivery_demands USING btree (created_by_id);


--
-- Name: delivery_demands_demand_code_dd1af490_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_demands_demand_code_dd1af490_like ON public.delivery_demands USING btree (demand_code varchar_pattern_ops);


--
-- Name: delivery_demands_outlet_id_9d294c11; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_demands_outlet_id_9d294c11 ON public.delivery_demands USING btree (outlet_id);


--
-- Name: delivery_demands_supplier_id_03ccae8f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_demands_supplier_id_03ccae8f ON public.delivery_demands USING btree (supplier_id);


--
-- Name: delivery_waves_vehicle_type_id_6443b32b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_waves_vehicle_type_id_6443b32b ON public.delivery_waves USING btree (vehicle_type_id);


--
-- Name: dem_outlet_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dem_outlet_date_idx ON public.delivery_demands USING btree (outlet_id, requested_date);


--
-- Name: dem_status_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dem_status_date_idx ON public.delivery_demands USING btree (status, requested_date);


--
-- Name: dem_supplier_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dem_supplier_date_idx ON public.delivery_demands USING btree (supplier_id, requested_date);


--
-- Name: demand_cost_inputs_cost_profile_id_a47bfca8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_cost_inputs_cost_profile_id_a47bfca8 ON public.demand_cost_inputs USING btree (cost_profile_id);


--
-- Name: demand_cost_inputs_demand_id_ea616792; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_cost_inputs_demand_id_ea616792 ON public.demand_cost_inputs USING btree (demand_id);


--
-- Name: demand_cost_inputs_evaluation_id_4948c636; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_cost_inputs_evaluation_id_4948c636 ON public.demand_cost_inputs USING btree (evaluation_id);


--
-- Name: demand_items_demand_id_9530bf42; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_items_demand_id_9530bf42 ON public.demand_items USING btree (demand_id);


--
-- Name: demand_items_item_id_dc5791dc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_items_item_id_dc5791dc ON public.demand_items USING btree (item_id);


--
-- Name: demand_sourcing_options_demand_item_id_c05876f0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_sourcing_options_demand_item_id_c05876f0 ON public.demand_sourcing_options USING btree (demand_item_id);


--
-- Name: demand_sourcing_options_supplier_item_id_5079eb59; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_sourcing_options_supplier_item_id_5079eb59 ON public.demand_sourcing_options USING btree (supplier_item_id);


--
-- Name: demand_supplier_selections_demand_id_8cf3b908; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_supplier_selections_demand_id_8cf3b908 ON public.demand_supplier_selections USING btree (demand_id);


--
-- Name: demand_supplier_selections_previous_request_id_9059ffbb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_supplier_selections_previous_request_id_9059ffbb ON public.demand_supplier_selections USING btree (previous_request_id);


--
-- Name: demand_supplier_selections_previous_supplier_id_9ca5d911; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_supplier_selections_previous_supplier_id_9ca5d911 ON public.demand_supplier_selections USING btree (previous_supplier_id);


--
-- Name: demand_supplier_selections_selected_by_id_dd4e18f6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_supplier_selections_selected_by_id_dd4e18f6 ON public.demand_supplier_selections USING btree (selected_by_id);


--
-- Name: demand_supplier_selections_selected_supplier_id_6dccb2bb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX demand_supplier_selections_selected_supplier_id_6dccb2bb ON public.demand_supplier_selections USING btree (selected_supplier_id);


--
-- Name: di_item_demand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX di_item_demand_idx ON public.demand_items USING btree (item_id, demand_id);


--
-- Name: django_admin_log_content_type_id_c4bce8eb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_admin_log_content_type_id_c4bce8eb ON public.django_admin_log USING btree (content_type_id);


--
-- Name: django_admin_log_user_id_c564eba6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_admin_log_user_id_c564eba6 ON public.django_admin_log USING btree (user_id);


--
-- Name: django_session_expire_date_a5c62663; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_session_expire_date_a5c62663 ON public.django_session USING btree (expire_date);


--
-- Name: django_session_session_key_c0390e0f_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_session_session_key_c0390e0f_like ON public.django_session USING btree (session_key varchar_pattern_ops);


--
-- Name: dso_ditem_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dso_ditem_status_idx ON public.demand_sourcing_options USING btree (demand_item_id, evaluation_status);


--
-- Name: dso_offer_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dso_offer_type_idx ON public.demand_sourcing_options USING btree (supplier_item_id, option_type);


--
-- Name: dss_previous_req_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dss_previous_req_idx ON public.demand_supplier_selections USING btree (previous_request_id);


--
-- Name: economic_evaluations_calculated_by_id_a9285c60; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economic_evaluations_calculated_by_id_a9285c60 ON public.economic_evaluations USING btree (calculated_by_id);


--
-- Name: economic_evaluations_cost_profile_id_0dbd0a70; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economic_evaluations_cost_profile_id_0dbd0a70 ON public.economic_evaluations USING btree (cost_profile_id);


--
-- Name: economic_evaluations_f4_evaluation_id_48f3c77d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economic_evaluations_f4_evaluation_id_48f3c77d ON public.economic_evaluations USING btree (f4_evaluation_id);


--
-- Name: economic_evaluations_plan_id_cd7219b5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX economic_evaluations_plan_id_cd7219b5 ON public.economic_evaluations USING btree (plan_id);


--
-- Name: external_user_access_provider_id_02e0e8b8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_user_access_provider_id_02e0e8b8 ON public.external_user_access USING btree (provider_id);


--
-- Name: external_user_access_supplier_id_c2a88ba4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_user_access_supplier_id_c2a88ba4 ON public.external_user_access USING btree (supplier_id);


--
-- Name: external_user_access_user_id_922de8a5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_user_access_user_id_922de8a5 ON public.external_user_access USING btree (user_id);


--
-- Name: f3_evaluations_evaluated_by_id_fbb3f554; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX f3_evaluations_evaluated_by_id_fbb3f554 ON public.f3_evaluations USING btree (evaluated_by_id);


--
-- Name: f4_evaluations_evaluated_by_id_86ef8893; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX f4_evaluations_evaluated_by_id_86ef8893 ON public.f4_evaluations USING btree (evaluated_by_id);


--
-- Name: f5_plan_calculated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX f5_plan_calculated_idx ON public.economic_evaluations USING btree (plan_id, calculated_at DESC);


--
-- Name: final_plan_demands_plan_id_30e8f068; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX final_plan_demands_plan_id_30e8f068 ON public.final_plan_demands USING btree (plan_id);


--
-- Name: final_plans_provider_id_bb1c6e11; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX final_plans_provider_id_bb1c6e11 ON public.final_plans USING btree (provider_id);


--
-- Name: final_plans_scenario_22b29923; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX final_plans_scenario_22b29923 ON public.final_plans USING btree (scenario);


--
-- Name: final_plans_scenario_22b29923_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX final_plans_scenario_22b29923_like ON public.final_plans USING btree (scenario varchar_pattern_ops);


--
-- Name: fulfillment_plans_created_by_id_b627efab; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fulfillment_plans_created_by_id_b627efab ON public.fulfillment_plans USING btree (created_by_id);


--
-- Name: fulfillment_plans_group_id_a83ba21c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fulfillment_plans_group_id_a83ba21c ON public.fulfillment_plans USING btree (group_id);


--
-- Name: fulfillment_plans_hub_id_421a69fc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fulfillment_plans_hub_id_421a69fc ON public.fulfillment_plans USING btree (hub_id);


--
-- Name: fulfillment_plans_plan_code_5d0bdbf6_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fulfillment_plans_plan_code_5d0bdbf6_like ON public.fulfillment_plans USING btree (plan_code varchar_pattern_ops);


--
-- Name: fulfillment_plans_supersedes_plan_id_cfd505ec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fulfillment_plans_supersedes_plan_id_cfd505ec ON public.fulfillment_plans USING btree (supersedes_plan_id);


--
-- Name: group_demands_demand_id_86957684; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_demands_demand_id_86957684 ON public.group_demands USING btree (demand_id);


--
-- Name: hub_coverage_evidence_hub_id_794f5608; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hub_coverage_evidence_hub_id_794f5608 ON public.hub_coverage_evidence USING btree (hub_id);


--
-- Name: hub_coverage_evidence_outlet_id_06e79479; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hub_coverage_evidence_outlet_id_06e79479 ON public.hub_coverage_evidence USING btree (outlet_id);


--
-- Name: hub_coverage_evidence_provider_id_daa05566; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hub_coverage_evidence_provider_id_daa05566 ON public.hub_coverage_evidence USING btree (provider_id);


--
-- Name: hub_coverage_evidence_supplier_id_77c2e006; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hub_coverage_evidence_supplier_id_77c2e006 ON public.hub_coverage_evidence USING btree (supplier_id);


--
-- Name: hubs_hub_code_32fb6f2e_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hubs_hub_code_32fb6f2e_like ON public.hubs USING btree (hub_code varchar_pattern_ops);


--
-- Name: inventory_balances_supplier_item_id_9ba61d2e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_balances_supplier_item_id_9ba61d2e ON public.inventory_balances USING btree (supplier_item_id);


--
-- Name: inventory_reservations_balance_id_df898d7d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_reservations_balance_id_df898d7d ON public.inventory_reservations USING btree (balance_id);


--
-- Name: inventory_transactions_actor_id_de2a29b8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_transactions_actor_id_de2a29b8 ON public.inventory_transactions USING btree (actor_id);


--
-- Name: inventory_transactions_balance_id_a2759ced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_transactions_balance_id_a2759ced ON public.inventory_transactions USING btree (balance_id);


--
-- Name: inventory_transactions_event_id_e80816d2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_transactions_event_id_e80816d2 ON public.inventory_transactions USING btree (event_id);


--
-- Name: inventory_transactions_reservation_id_4226e593; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_transactions_reservation_id_4226e593 ON public.inventory_transactions USING btree (reservation_id);


--
-- Name: items_cargo_category_id_de89ed97; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_cargo_category_id_de89ed97 ON public.items USING btree (cargo_category_id);


--
-- Name: items_item_code_1de4bbcf_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_item_code_1de4bbcf_like ON public.items USING btree (item_code varchar_pattern_ops);


--
-- Name: ix_collab_groups_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_collab_groups_run_status ON public.collaboration_groups USING btree (run_code, status);


--
-- Name: ix_cp11_execution_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cp11_execution_history ON public.logistics_execution_events USING btree (plan_id, demand_id, id);


--
-- Name: ix_cp11_fleet_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cp11_fleet_window ON public.logistics_fleet_holds USING btree (offer_id, starts_at, ends_at);


--
-- Name: ix_cp12_plan_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cp12_plan_mode ON public.logistics_reconciliation_records USING btree (plan_id, mode, id);


--
-- Name: ix_fulfillment_plans_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_fulfillment_plans_status ON public.fulfillment_plans USING btree (status);


--
-- Name: ix_planning_runs_actor_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_planning_runs_actor_time ON public.planning_runs USING btree (initiated_by_id, started_at);


--
-- Name: ix_planning_runs_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_planning_runs_status_time ON public.planning_runs USING btree (status, started_at);


--
-- Name: ix_run_demands_eligibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_run_demands_eligibility ON public.planning_run_demands USING btree (planning_run_id, eligibility_status);


--
-- Name: ix_run_demands_matching; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_run_demands_matching ON public.planning_run_demands USING btree (planning_run_id, matching_status);


--
-- Name: logistics_execution_events_actor_id_9015215d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logistics_execution_events_actor_id_9015215d ON public.logistics_execution_events USING btree (actor_id);


--
-- Name: logistics_execution_events_demand_id_3b21d594; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logistics_execution_events_demand_id_3b21d594 ON public.logistics_execution_events USING btree (demand_id);


--
-- Name: logistics_execution_events_plan_id_ac977dae; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logistics_execution_events_plan_id_ac977dae ON public.logistics_execution_events USING btree (plan_id);


--
-- Name: logistics_fleet_holds_offer_id_3aacc155; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logistics_fleet_holds_offer_id_3aacc155 ON public.logistics_fleet_holds USING btree (offer_id);


--
-- Name: logistics_fleet_holds_plan_id_ca2d0877; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logistics_fleet_holds_plan_id_ca2d0877 ON public.logistics_fleet_holds USING btree (plan_id);


--
-- Name: logistics_reconciliation_records_actor_id_911e4265; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logistics_reconciliation_records_actor_id_911e4265 ON public.logistics_reconciliation_records USING btree (actor_id);


--
-- Name: logistics_reconciliation_records_plan_id_2aa26753; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX logistics_reconciliation_records_plan_id_2aa26753 ON public.logistics_reconciliation_records USING btree (plan_id);


--
-- Name: md_item_cat_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX md_item_cat_active_idx ON public.items USING btree (cargo_category_id, is_active);


--
-- Name: md_sitem_item_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX md_sitem_item_status_idx ON public.supplier_items USING btree (item_id, offer_status);


--
-- Name: md_sitem_supplier_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX md_sitem_supplier_status_idx ON public.supplier_items USING btree (supplier_id, offer_status);


--
-- Name: operational_evidence_recorded_by_id_10853c27; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operational_evidence_recorded_by_id_10853c27 ON public.operational_evidence USING btree (recorded_by_id);


--
-- Name: operational_evidence_scenario_c5cd2f00; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operational_evidence_scenario_c5cd2f00 ON public.operational_evidence USING btree (scenario);


--
-- Name: operational_evidence_scenario_c5cd2f00_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operational_evidence_scenario_c5cd2f00_like ON public.operational_evidence USING btree (scenario varchar_pattern_ops);


--
-- Name: outlets_outlet_code_3171b157_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outlets_outlet_code_3171b157_like ON public.outlets USING btree (outlet_code varchar_pattern_ops);


--
-- Name: plan_decisions_actor_id_bc88cd79; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_decisions_actor_id_bc88cd79 ON public.plan_decisions USING btree (actor_id);


--
-- Name: plan_decisions_evaluation_id_45090566; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_decisions_evaluation_id_45090566 ON public.plan_decisions USING btree (evaluation_id);


--
-- Name: plan_decisions_group_id_8884974e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_decisions_group_id_8884974e ON public.plan_decisions USING btree (group_id);


--
-- Name: planning_parameters_parameter_key_215dd83f_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planning_parameters_parameter_key_215dd83f_like ON public.planning_parameters USING btree (parameter_key varchar_pattern_ops);


--
-- Name: planning_parameters_updated_by_id_65cd5823; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planning_parameters_updated_by_id_65cd5823 ON public.planning_parameters USING btree (updated_by_id);


--
-- Name: planning_run_demands_demand_id_25f0136f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planning_run_demands_demand_id_25f0136f ON public.planning_run_demands USING btree (demand_id);


--
-- Name: planning_runs_cost_profile_id_3f4fc696; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planning_runs_cost_profile_id_3f4fc696 ON public.planning_runs USING btree (cost_profile_id);


--
-- Name: planning_runs_rule_set_id_cec4d810; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planning_runs_rule_set_id_cec4d810 ON public.planning_runs USING btree (rule_set_id);


--
-- Name: provider_availability_provider_vehicle_id_e3e83254; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_availability_provider_vehicle_id_e3e83254 ON public.provider_availability USING btree (provider_vehicle_id);


--
-- Name: provider_supplier_coverage_provider_id_8b56c475; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_supplier_coverage_provider_id_8b56c475 ON public.provider_supplier_coverage USING btree (provider_id);


--
-- Name: provider_supplier_coverage_supplier_id_411da197; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_supplier_coverage_supplier_id_411da197 ON public.provider_supplier_coverage USING btree (supplier_id);


--
-- Name: provider_vehicle_offers_provider_id_e7eff04a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_vehicle_offers_provider_id_e7eff04a ON public.provider_vehicle_offers USING btree (provider_id);


--
-- Name: provider_vehicle_offers_vehicle_type_id_11dfd4cd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_vehicle_offers_vehicle_type_id_11dfd4cd ON public.provider_vehicle_offers USING btree (vehicle_type_id);


--
-- Name: receiving_slots_outlet_id_420201a1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receiving_slots_outlet_id_420201a1 ON public.receiving_slots USING btree (outlet_id);


--
-- Name: receiving_windows_outlet_id_ed952960; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receiving_windows_outlet_id_ed952960 ON public.receiving_windows USING btree (outlet_id);


--
-- Name: roles_code_e726c310_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX roles_code_e726c310_like ON public.roles USING btree (code varchar_pattern_ops);


--
-- Name: rule_sets_created_by_id_b256cd5d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rule_sets_created_by_id_b256cd5d ON public.rule_sets USING btree (created_by_id);


--
-- Name: rule_sets_rule_set_code_ea98a492_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rule_sets_rule_set_code_ea98a492_like ON public.rule_sets USING btree (rule_set_code varchar_pattern_ops);


--
-- Name: sc_demand_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sc_demand_status_idx ON public.supplier_confirmations USING btree (demand_id, confirmation_status);


--
-- Name: sc_supplier_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sc_supplier_status_idx ON public.supplier_confirmations USING btree (supplier_id, confirmation_status);


--
-- Name: sip_ditem_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sip_ditem_request_idx ON public.supplier_item_promises USING btree (demand_item_id, supplier_request_id);


--
-- Name: sip_request_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sip_request_status_idx ON public.supplier_item_promises USING btree (supplier_request_id, line_status);


--
-- Name: sr_demand_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sr_demand_attempt_idx ON public.supplier_requests USING btree (demand_id, attempt_no);


--
-- Name: sr_one_waiting_per_demand; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sr_one_waiting_per_demand ON public.supplier_requests USING btree (demand_id) WHERE ((request_status)::text = 'WAITING'::text);


--
-- Name: sr_supplier_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sr_supplier_status_idx ON public.supplier_requests USING btree (supplier_id, request_status);


--
-- Name: supplier_confirmations_commitment_released_by_id_ffac5721; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_confirmations_commitment_released_by_id_ffac5721 ON public.supplier_confirmations USING btree (commitment_released_by_id);


--
-- Name: supplier_confirmations_demand_id_c7dbceea; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_confirmations_demand_id_c7dbceea ON public.supplier_confirmations USING btree (demand_id);


--
-- Name: supplier_confirmations_supplier_id_efd4e769; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_confirmations_supplier_id_efd4e769 ON public.supplier_confirmations USING btree (supplier_id);


--
-- Name: supplier_item_promises_demand_item_id_6da263fd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_item_promises_demand_item_id_6da263fd ON public.supplier_item_promises USING btree (demand_item_id);


--
-- Name: supplier_item_promises_supplier_item_id_28d3bd65; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_item_promises_supplier_item_id_28d3bd65 ON public.supplier_item_promises USING btree (supplier_item_id);


--
-- Name: supplier_item_promises_supplier_request_id_8b5ad847; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_item_promises_supplier_request_id_8b5ad847 ON public.supplier_item_promises USING btree (supplier_request_id);


--
-- Name: supplier_items_item_id_c3340e44; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_items_item_id_c3340e44 ON public.supplier_items USING btree (item_id);


--
-- Name: supplier_items_supplier_id_5f2bd780; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_items_supplier_id_5f2bd780 ON public.supplier_items USING btree (supplier_id);


--
-- Name: supplier_requests_created_by_id_25c9f9bd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_requests_created_by_id_25c9f9bd ON public.supplier_requests USING btree (created_by_id);


--
-- Name: supplier_requests_demand_id_58058ffe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_requests_demand_id_58058ffe ON public.supplier_requests USING btree (demand_id);


--
-- Name: supplier_requests_request_code_2dc529e0_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_requests_request_code_2dc529e0_like ON public.supplier_requests USING btree (request_code varchar_pattern_ops);


--
-- Name: supplier_requests_supplier_id_99cffd50; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_requests_supplier_id_99cffd50 ON public.supplier_requests USING btree (supplier_id);


--
-- Name: suppliers_supplier_code_94839cb7_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX suppliers_supplier_code_94839cb7_like ON public.suppliers USING btree (supplier_code varchar_pattern_ops);


--
-- Name: tr_avail_offer_date_src_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tr_avail_offer_date_src_idx ON public.provider_availability USING btree (provider_vehicle_id, service_date, source_mode);


--
-- Name: transport_handover_responses_actor_id_f47b9821; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transport_handover_responses_actor_id_f47b9821 ON public.transport_handover_responses USING btree (actor_id);


--
-- Name: transport_handovers_actor_id_5425f563; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transport_handovers_actor_id_5425f563 ON public.transport_handovers USING btree (actor_id);


--
-- Name: transport_providers_provider_code_3fd75788_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transport_providers_provider_code_3fd75788_like ON public.transport_providers USING btree (provider_code varchar_pattern_ops);


--
-- Name: uq_cp11_pickup_reservation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cp11_pickup_reservation ON public.inventory_transactions USING btree (reservation_id, kind) WHERE ((kind)::text = 'PICKUP'::text);


--
-- Name: uq_cp11_stock_opening; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cp11_stock_opening ON public.inventory_transactions USING btree (balance_id) WHERE ((kind)::text = 'OPENING'::text);


--
-- Name: uq_fulfillment_plan_f2_identity_root; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_fulfillment_plan_f2_identity_root ON public.fulfillment_plans USING btree (group_id, template_type, hub_id) NULLS NOT DISTINCT WHERE ((f2_structure IS NOT NULL) AND (supersedes_plan_id IS NULL));


--
-- Name: uq_fulfillment_plan_f2_identity_successor; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_fulfillment_plan_f2_identity_successor ON public.fulfillment_plans USING btree (supersedes_plan_id, template_type, hub_id) NULLS NOT DISTINCT WHERE ((f2_structure IS NOT NULL) AND (supersedes_plan_id IS NOT NULL));


--
-- Name: user_outlet_access_assigned_by_id_4c83bab5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_outlet_access_assigned_by_id_4c83bab5 ON public.user_outlet_access USING btree (assigned_by_id);


--
-- Name: user_outlet_access_outlet_id_cda08970; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_outlet_access_outlet_id_cda08970 ON public.user_outlet_access USING btree (outlet_id);


--
-- Name: user_outlet_access_user_id_ad9e1957; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_outlet_access_user_id_ad9e1957 ON public.user_outlet_access USING btree (user_id);


--
-- Name: user_roles_assigned_by_id_a9db12d1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_roles_assigned_by_id_a9db12d1 ON public.user_roles USING btree (assigned_by_id);


--
-- Name: user_roles_role_id_816a4486; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_roles_role_id_816a4486 ON public.user_roles USING btree (role_id);


--
-- Name: user_roles_user_id_9d9f8dbb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_roles_user_id_9d9f8dbb ON public.user_roles USING btree (user_id);


--
-- Name: users_capstone_scenario_07173a0c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_capstone_scenario_07173a0c ON public.users USING btree (capstone_scenario);


--
-- Name: users_capstone_scenario_07173a0c_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_capstone_scenario_07173a0c_like ON public.users USING btree (capstone_scenario varchar_pattern_ops);


--
-- Name: users_email_0ea73cca_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_email_0ea73cca_like ON public.users USING btree (email varchar_pattern_ops);


--
-- Name: users_groups_group_id_2f3517aa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_groups_group_id_2f3517aa ON public.users_groups USING btree (group_id);


--
-- Name: users_groups_user_id_f500bee5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_groups_user_id_f500bee5 ON public.users_groups USING btree (user_id);


--
-- Name: users_user_permissions_permission_id_6d08dcd2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_user_permissions_permission_id_6d08dcd2 ON public.users_user_permissions USING btree (permission_id);


--
-- Name: users_user_permissions_user_id_92473840; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_user_permissions_user_id_92473840 ON public.users_user_permissions USING btree (user_id);


--
-- Name: vehicle_cargo_compatibility_cargo_category_id_fdcd1c35; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vehicle_cargo_compatibility_cargo_category_id_fdcd1c35 ON public.vehicle_cargo_compatibility USING btree (cargo_category_id);


--
-- Name: vehicle_cargo_compatibility_vehicle_type_id_86df483f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vehicle_cargo_compatibility_vehicle_type_id_86df483f ON public.vehicle_cargo_compatibility USING btree (vehicle_type_id);


--
-- Name: vehicle_types_vehicle_code_eff69a99_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vehicle_types_vehicle_code_eff69a99_like ON public.vehicle_types USING btree (vehicle_code varchar_pattern_ops);


--
-- Name: wave_demands_demand_id_3b193838; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wave_demands_demand_id_3b193838 ON public.wave_demands USING btree (demand_id);


--
-- Name: plan_decisions cp09_decision_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cp09_decision_immutable BEFORE DELETE OR UPDATE ON public.plan_decisions FOR EACH ROW EXECUTE FUNCTION public.cp09_cp10_require_append_only();


--
-- Name: final_plans cp09_final_plan_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cp09_final_plan_immutable BEFORE DELETE OR UPDATE ON public.final_plans FOR EACH ROW EXECUTE FUNCTION public.cp09_cp10_require_append_only();


--
-- Name: transport_handovers cp10_handover_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cp10_handover_immutable BEFORE DELETE OR UPDATE ON public.transport_handovers FOR EACH ROW EXECUTE FUNCTION public.cp09_cp10_require_append_only();


--
-- Name: transport_handover_responses cp10_response_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cp10_response_immutable BEFORE DELETE OR UPDATE ON public.transport_handover_responses FOR EACH ROW EXECUTE FUNCTION public.cp09_cp10_require_append_only();


--
-- Name: logistics_execution_events cp11_execution_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cp11_execution_immutable BEFORE DELETE OR UPDATE ON public.logistics_execution_events FOR EACH ROW EXECUTE FUNCTION public.cp09_cp10_require_append_only();


--
-- Name: inventory_transactions cp11_inventory_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cp11_inventory_immutable BEFORE DELETE OR UPDATE ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION public.cp09_cp10_require_append_only();


--
-- Name: logistics_reconciliation_records cp12_reconciliation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cp12_reconciliation_immutable BEFORE DELETE OR UPDATE ON public.logistics_reconciliation_records FOR EACH ROW EXECUTE FUNCTION public.cp09_cp10_require_append_only();


--
-- Name: f3_evaluations f3_evaluation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER f3_evaluation_immutable BEFORE DELETE OR UPDATE ON public.f3_evaluations FOR EACH ROW EXECUTE FUNCTION public.planning_block_f3_evaluation_change();


--
-- Name: f4_evaluations f4_evaluation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER f4_evaluation_immutable BEFORE DELETE OR UPDATE ON public.f4_evaluations FOR EACH ROW EXECUTE FUNCTION public.planning_block_f4_evaluation_change();


--
-- Name: cost_allocations f5_cost_allocation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER f5_cost_allocation_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.cost_allocations FOR EACH ROW EXECUTE FUNCTION public.planning_f5_child_guard();


--
-- Name: cost_components f5_cost_component_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER f5_cost_component_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.cost_components FOR EACH ROW EXECUTE FUNCTION public.planning_f5_child_guard();


--
-- Name: demand_cost_inputs f5_demand_cost_input_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER f5_demand_cost_input_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.demand_cost_inputs FOR EACH ROW EXECUTE FUNCTION public.planning_f5_child_guard();


--
-- Name: economic_evaluations f5_evaluation_seal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER f5_evaluation_seal BEFORE INSERT OR DELETE OR UPDATE ON public.economic_evaluations FOR EACH ROW EXECUTE FUNCTION public.planning_f5_seal();


--
-- Name: economic_evaluations f5_evaluation_sealed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER f5_evaluation_sealed AFTER INSERT ON public.economic_evaluations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.planning_f5_require_sealed();


--
-- Name: audit_logs audit_logs_actor_user_id_01017f5b_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_user_id_01017f5b_fk_users_id FOREIGN KEY (actor_user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_group_permissions auth_group_permissio_permission_id_84c5c92e_fk_auth_perm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissio_permission_id_84c5c92e_fk_auth_perm FOREIGN KEY (permission_id) REFERENCES public.auth_permission(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_group_permissions auth_group_permissions_group_id_b120cbf9_fk_auth_group_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_group_id_b120cbf9_fk_auth_group_id FOREIGN KEY (group_id) REFERENCES public.auth_group(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_permission auth_permission_content_type_id_2f476e4b_fk_django_co; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_content_type_id_2f476e4b_fk_django_co FOREIGN KEY (content_type_id) REFERENCES public.django_content_type(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: authtoken_token authtoken_token_user_id_35299eff_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authtoken_token
    ADD CONSTRAINT authtoken_token_user_id_35299eff_fk_users_id FOREIGN KEY (user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: business_rules business_rules_rule_set_id_872a003c_fk_rule_sets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_rules
    ADD CONSTRAINT business_rules_rule_set_id_872a003c_fk_rule_sets_id FOREIGN KEY (rule_set_id) REFERENCES public.rule_sets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: collaboration_groups collaboration_groups_created_by_id_73b1ce89_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_groups
    ADD CONSTRAINT collaboration_groups_created_by_id_73b1ce89_fk_users_id FOREIGN KEY (created_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: cost_allocations cost_allocations_evaluation_id_0b0d32bd_fk_economic_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_evaluation_id_0b0d32bd_fk_economic_ FOREIGN KEY (evaluation_id) REFERENCES public.economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: cost_allocations cost_allocations_outlet_id_3ae334b8_fk_outlets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_outlet_id_3ae334b8_fk_outlets_id FOREIGN KEY (outlet_id) REFERENCES public.outlets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: cost_components cost_components_delivery_wave_id_9456ed1a_fk_delivery_waves_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_components
    ADD CONSTRAINT cost_components_delivery_wave_id_9456ed1a_fk_delivery_waves_id FOREIGN KEY (delivery_wave_id) REFERENCES public.delivery_waves(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: cost_components cost_components_evaluation_id_25f94fbe_fk_economic_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_components
    ADD CONSTRAINT cost_components_evaluation_id_25f94fbe_fk_economic_ FOREIGN KEY (evaluation_id) REFERENCES public.economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: delivery_demands delivery_demands_cargo_category_id_338ab084_fk_cargo_cat; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_demands
    ADD CONSTRAINT delivery_demands_cargo_category_id_338ab084_fk_cargo_cat FOREIGN KEY (cargo_category_id) REFERENCES public.cargo_categories(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: delivery_demands delivery_demands_created_by_id_5aaf9c9c_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_demands
    ADD CONSTRAINT delivery_demands_created_by_id_5aaf9c9c_fk_users_id FOREIGN KEY (created_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: delivery_demands delivery_demands_outlet_id_9d294c11_fk_outlets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_demands
    ADD CONSTRAINT delivery_demands_outlet_id_9d294c11_fk_outlets_id FOREIGN KEY (outlet_id) REFERENCES public.outlets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: delivery_demands delivery_demands_supplier_id_03ccae8f_fk_suppliers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_demands
    ADD CONSTRAINT delivery_demands_supplier_id_03ccae8f_fk_suppliers_id FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: delivery_waves delivery_waves_plan_id_1f8c33eb_fk_fulfillment_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_waves
    ADD CONSTRAINT delivery_waves_plan_id_1f8c33eb_fk_fulfillment_plans_id FOREIGN KEY (plan_id) REFERENCES public.fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: delivery_waves delivery_waves_vehicle_type_id_6443b32b_fk_vehicle_types_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_waves
    ADD CONSTRAINT delivery_waves_vehicle_type_id_6443b32b_fk_vehicle_types_id FOREIGN KEY (vehicle_type_id) REFERENCES public.vehicle_types(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_cost_inputs demand_cost_inputs_cost_profile_id_a47bfca8_fk_cost_profiles_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_cost_inputs
    ADD CONSTRAINT demand_cost_inputs_cost_profile_id_a47bfca8_fk_cost_profiles_id FOREIGN KEY (cost_profile_id) REFERENCES public.cost_profiles(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_cost_inputs demand_cost_inputs_demand_id_ea616792_fk_delivery_demands_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_cost_inputs
    ADD CONSTRAINT demand_cost_inputs_demand_id_ea616792_fk_delivery_demands_id FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_cost_inputs demand_cost_inputs_evaluation_id_4948c636_fk_economic_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_cost_inputs
    ADD CONSTRAINT demand_cost_inputs_evaluation_id_4948c636_fk_economic_ FOREIGN KEY (evaluation_id) REFERENCES public.economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_items demand_items_demand_id_9530bf42_fk_delivery_demands_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_items
    ADD CONSTRAINT demand_items_demand_id_9530bf42_fk_delivery_demands_id FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_items demand_items_item_id_dc5791dc_fk_items_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_items
    ADD CONSTRAINT demand_items_item_id_dc5791dc_fk_items_id FOREIGN KEY (item_id) REFERENCES public.items(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_sourcing_options demand_sourcing_opti_demand_item_id_c05876f0_fk_demand_it; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_sourcing_options
    ADD CONSTRAINT demand_sourcing_opti_demand_item_id_c05876f0_fk_demand_it FOREIGN KEY (demand_item_id) REFERENCES public.demand_items(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_sourcing_options demand_sourcing_opti_supplier_item_id_5079eb59_fk_supplier_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_sourcing_options
    ADD CONSTRAINT demand_sourcing_opti_supplier_item_id_5079eb59_fk_supplier_ FOREIGN KEY (supplier_item_id) REFERENCES public.supplier_items(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_supplier_selections demand_supplier_sele_demand_id_8cf3b908_fk_delivery_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_supplier_selections
    ADD CONSTRAINT demand_supplier_sele_demand_id_8cf3b908_fk_delivery_ FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_supplier_selections demand_supplier_sele_previous_request_id_9059ffbb_fk_supplier_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_supplier_selections
    ADD CONSTRAINT demand_supplier_sele_previous_request_id_9059ffbb_fk_supplier_ FOREIGN KEY (previous_request_id) REFERENCES public.supplier_requests(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_supplier_selections demand_supplier_sele_previous_supplier_id_9ca5d911_fk_suppliers; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_supplier_selections
    ADD CONSTRAINT demand_supplier_sele_previous_supplier_id_9ca5d911_fk_suppliers FOREIGN KEY (previous_supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_supplier_selections demand_supplier_sele_selected_supplier_id_6dccb2bb_fk_suppliers; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_supplier_selections
    ADD CONSTRAINT demand_supplier_sele_selected_supplier_id_6dccb2bb_fk_suppliers FOREIGN KEY (selected_supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: demand_supplier_selections demand_supplier_selections_selected_by_id_dd4e18f6_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_supplier_selections
    ADD CONSTRAINT demand_supplier_selections_selected_by_id_dd4e18f6_fk_users_id FOREIGN KEY (selected_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: django_admin_log django_admin_log_content_type_id_c4bce8eb_fk_django_co; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_content_type_id_c4bce8eb_fk_django_co FOREIGN KEY (content_type_id) REFERENCES public.django_content_type(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: django_admin_log django_admin_log_user_id_c564eba6_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_user_id_c564eba6_fk_users_id FOREIGN KEY (user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: economic_evaluations economic_evaluations_calculated_by_id_a9285c60_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economic_evaluations
    ADD CONSTRAINT economic_evaluations_calculated_by_id_a9285c60_fk_users_id FOREIGN KEY (calculated_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: economic_evaluations economic_evaluations_cost_profile_id_0dbd0a70_fk_cost_prof; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economic_evaluations
    ADD CONSTRAINT economic_evaluations_cost_profile_id_0dbd0a70_fk_cost_prof FOREIGN KEY (cost_profile_id) REFERENCES public.cost_profiles(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: economic_evaluations economic_evaluations_f4_evaluation_id_48f3c77d_fk_f4_evalua; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economic_evaluations
    ADD CONSTRAINT economic_evaluations_f4_evaluation_id_48f3c77d_fk_f4_evalua FOREIGN KEY (f4_evaluation_id) REFERENCES public.f4_evaluations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: economic_evaluations economic_evaluations_plan_id_cd7219b5_fk_fulfillment_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.economic_evaluations
    ADD CONSTRAINT economic_evaluations_plan_id_cd7219b5_fk_fulfillment_plans_id FOREIGN KEY (plan_id) REFERENCES public.fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: external_user_access external_user_access_provider_id_02e0e8b8_fk_transport; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_user_access
    ADD CONSTRAINT external_user_access_provider_id_02e0e8b8_fk_transport FOREIGN KEY (provider_id) REFERENCES public.transport_providers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: external_user_access external_user_access_supplier_id_c2a88ba4_fk_suppliers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_user_access
    ADD CONSTRAINT external_user_access_supplier_id_c2a88ba4_fk_suppliers_id FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: external_user_access external_user_access_user_id_922de8a5_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_user_access
    ADD CONSTRAINT external_user_access_user_id_922de8a5_fk_users_id FOREIGN KEY (user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: f3_evaluations f3_evaluations_evaluated_by_id_fbb3f554_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f3_evaluations
    ADD CONSTRAINT f3_evaluations_evaluated_by_id_fbb3f554_fk_users_id FOREIGN KEY (evaluated_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: f3_evaluations f3_evaluations_plan_id_90b40883_fk_fulfillment_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f3_evaluations
    ADD CONSTRAINT f3_evaluations_plan_id_90b40883_fk_fulfillment_plans_id FOREIGN KEY (plan_id) REFERENCES public.fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: f4_evaluations f4_evaluations_evaluated_by_id_86ef8893_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f4_evaluations
    ADD CONSTRAINT f4_evaluations_evaluated_by_id_86ef8893_fk_users_id FOREIGN KEY (evaluated_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: f4_evaluations f4_evaluations_f3_evaluation_id_3918fee4_fk_f3_evaluations_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.f4_evaluations
    ADD CONSTRAINT f4_evaluations_f3_evaluation_id_3918fee4_fk_f3_evaluations_id FOREIGN KEY (f3_evaluation_id) REFERENCES public.f3_evaluations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: final_plan_demands final_plan_demands_demand_id_36d1088d_fk_delivery_demands_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plan_demands
    ADD CONSTRAINT final_plan_demands_demand_id_36d1088d_fk_delivery_demands_id FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: final_plan_demands final_plan_demands_plan_id_30e8f068_fk_final_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plan_demands
    ADD CONSTRAINT final_plan_demands_plan_id_30e8f068_fk_final_plans_id FOREIGN KEY (plan_id) REFERENCES public.final_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: final_plans final_plans_decision_id_ad9aabc6_fk_plan_decisions_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT final_plans_decision_id_ad9aabc6_fk_plan_decisions_id FOREIGN KEY (decision_id) REFERENCES public.plan_decisions(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: final_plans final_plans_provider_id_bb1c6e11_fk_transport_providers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT final_plans_provider_id_bb1c6e11_fk_transport_providers_id FOREIGN KEY (provider_id) REFERENCES public.transport_providers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: final_plans final_plans_supersedes_id_2c9b5436_fk_final_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_plans
    ADD CONSTRAINT final_plans_supersedes_id_2c9b5436_fk_final_plans_id FOREIGN KEY (supersedes_id) REFERENCES public.final_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: fulfillment_plans fulfillment_plans_created_by_id_b627efab_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_plans
    ADD CONSTRAINT fulfillment_plans_created_by_id_b627efab_fk_users_id FOREIGN KEY (created_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: fulfillment_plans fulfillment_plans_group_id_a83ba21c_fk_collaboration_groups_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_plans
    ADD CONSTRAINT fulfillment_plans_group_id_a83ba21c_fk_collaboration_groups_id FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: fulfillment_plans fulfillment_plans_hub_id_421a69fc_fk_hubs_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_plans
    ADD CONSTRAINT fulfillment_plans_hub_id_421a69fc_fk_hubs_id FOREIGN KEY (hub_id) REFERENCES public.hubs(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: fulfillment_plans fulfillment_plans_supersedes_plan_id_cfd505ec_fk_fulfillme; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_plans
    ADD CONSTRAINT fulfillment_plans_supersedes_plan_id_cfd505ec_fk_fulfillme FOREIGN KEY (supersedes_plan_id) REFERENCES public.fulfillment_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: group_demands group_demands_demand_id_86957684_fk_delivery_demands_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_demands
    ADD CONSTRAINT group_demands_demand_id_86957684_fk_delivery_demands_id FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: group_demands group_demands_group_id_ba7c0759_fk_collaboration_groups_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_demands
    ADD CONSTRAINT group_demands_group_id_ba7c0759_fk_collaboration_groups_id FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: hub_coverage_evidence hub_coverage_evidenc_provider_id_daa05566_fk_transport; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_coverage_evidence
    ADD CONSTRAINT hub_coverage_evidenc_provider_id_daa05566_fk_transport FOREIGN KEY (provider_id) REFERENCES public.transport_providers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: hub_coverage_evidence hub_coverage_evidence_hub_id_794f5608_fk_hubs_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_coverage_evidence
    ADD CONSTRAINT hub_coverage_evidence_hub_id_794f5608_fk_hubs_id FOREIGN KEY (hub_id) REFERENCES public.hubs(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: hub_coverage_evidence hub_coverage_evidence_outlet_id_06e79479_fk_outlets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_coverage_evidence
    ADD CONSTRAINT hub_coverage_evidence_outlet_id_06e79479_fk_outlets_id FOREIGN KEY (outlet_id) REFERENCES public.outlets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: hub_coverage_evidence hub_coverage_evidence_supplier_id_77c2e006_fk_suppliers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_coverage_evidence
    ADD CONSTRAINT hub_coverage_evidence_supplier_id_77c2e006_fk_suppliers_id FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: inventory_balances inventory_balances_supplier_item_id_9ba61d2e_fk_supplier_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balances
    ADD CONSTRAINT inventory_balances_supplier_item_id_9ba61d2e_fk_supplier_ FOREIGN KEY (supplier_item_id) REFERENCES public.supplier_items(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: inventory_reservations inventory_reservatio_balance_id_df898d7d_fk_inventory; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_reservations
    ADD CONSTRAINT inventory_reservatio_balance_id_df898d7d_fk_inventory FOREIGN KEY (balance_id) REFERENCES public.inventory_balances(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: inventory_reservations inventory_reservatio_promise_id_8aa50a6c_fk_supplier_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_reservations
    ADD CONSTRAINT inventory_reservatio_promise_id_8aa50a6c_fk_supplier_ FOREIGN KEY (promise_id) REFERENCES public.supplier_item_promises(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: inventory_transactions inventory_transactio_balance_id_a2759ced_fk_inventory; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactio_balance_id_a2759ced_fk_inventory FOREIGN KEY (balance_id) REFERENCES public.inventory_balances(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: inventory_transactions inventory_transactio_event_id_e80816d2_fk_logistics; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactio_event_id_e80816d2_fk_logistics FOREIGN KEY (event_id) REFERENCES public.logistics_execution_events(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: inventory_transactions inventory_transactio_reservation_id_4226e593_fk_inventory; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactio_reservation_id_4226e593_fk_inventory FOREIGN KEY (reservation_id) REFERENCES public.inventory_reservations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: inventory_transactions inventory_transactions_actor_id_de2a29b8_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_actor_id_de2a29b8_fk_users_id FOREIGN KEY (actor_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: items items_cargo_category_id_de89ed97_fk_cargo_categories_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_cargo_category_id_de89ed97_fk_cargo_categories_id FOREIGN KEY (cargo_category_id) REFERENCES public.cargo_categories(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: logistics_execution_events logistics_execution__demand_id_3b21d594_fk_delivery_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_execution_events
    ADD CONSTRAINT logistics_execution__demand_id_3b21d594_fk_delivery_ FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: logistics_execution_events logistics_execution_events_actor_id_9015215d_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_execution_events
    ADD CONSTRAINT logistics_execution_events_actor_id_9015215d_fk_users_id FOREIGN KEY (actor_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: logistics_execution_events logistics_execution_events_plan_id_ac977dae_fk_final_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_execution_events
    ADD CONSTRAINT logistics_execution_events_plan_id_ac977dae_fk_final_plans_id FOREIGN KEY (plan_id) REFERENCES public.final_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: logistics_fleet_holds logistics_fleet_hold_offer_id_3aacc155_fk_provider_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_fleet_holds
    ADD CONSTRAINT logistics_fleet_hold_offer_id_3aacc155_fk_provider_ FOREIGN KEY (offer_id) REFERENCES public.provider_vehicle_offers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: logistics_fleet_holds logistics_fleet_holds_plan_id_ca2d0877_fk_final_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_fleet_holds
    ADD CONSTRAINT logistics_fleet_holds_plan_id_ca2d0877_fk_final_plans_id FOREIGN KEY (plan_id) REFERENCES public.final_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: logistics_reconciliation_records logistics_reconcilia_plan_id_2aa26753_fk_final_pla; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_reconciliation_records
    ADD CONSTRAINT logistics_reconcilia_plan_id_2aa26753_fk_final_pla FOREIGN KEY (plan_id) REFERENCES public.final_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: logistics_reconciliation_records logistics_reconciliation_records_actor_id_911e4265_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_reconciliation_records
    ADD CONSTRAINT logistics_reconciliation_records_actor_id_911e4265_fk_users_id FOREIGN KEY (actor_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: operational_evidence operational_evidence_recorded_by_id_10853c27_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_evidence
    ADD CONSTRAINT operational_evidence_recorded_by_id_10853c27_fk_users_id FOREIGN KEY (recorded_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: plan_decisions plan_decisions_actor_id_bc88cd79_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_decisions
    ADD CONSTRAINT plan_decisions_actor_id_bc88cd79_fk_users_id FOREIGN KEY (actor_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: plan_decisions plan_decisions_evaluation_id_45090566_fk_economic_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_decisions
    ADD CONSTRAINT plan_decisions_evaluation_id_45090566_fk_economic_ FOREIGN KEY (evaluation_id) REFERENCES public.economic_evaluations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: plan_decisions plan_decisions_group_id_8884974e_fk_collaboration_groups_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_decisions
    ADD CONSTRAINT plan_decisions_group_id_8884974e_fk_collaboration_groups_id FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: planning_parameters planning_parameters_updated_by_id_65cd5823_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_parameters
    ADD CONSTRAINT planning_parameters_updated_by_id_65cd5823_fk_users_id FOREIGN KEY (updated_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: planning_run_demands planning_run_demands_demand_id_25f0136f_fk_delivery_demands_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_run_demands
    ADD CONSTRAINT planning_run_demands_demand_id_25f0136f_fk_delivery_demands_id FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: planning_run_demands planning_run_demands_planning_run_id_da84aa66_fk_planning_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_run_demands
    ADD CONSTRAINT planning_run_demands_planning_run_id_da84aa66_fk_planning_ FOREIGN KEY (planning_run_id) REFERENCES public.planning_runs(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: planning_runs planning_runs_cost_profile_id_3f4fc696_fk_cost_profiles_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_runs
    ADD CONSTRAINT planning_runs_cost_profile_id_3f4fc696_fk_cost_profiles_id FOREIGN KEY (cost_profile_id) REFERENCES public.cost_profiles(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: planning_runs planning_runs_initiated_by_id_e6671e1d_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_runs
    ADD CONSTRAINT planning_runs_initiated_by_id_e6671e1d_fk_users_id FOREIGN KEY (initiated_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: planning_runs planning_runs_rule_set_id_cec4d810_fk_rule_sets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_runs
    ADD CONSTRAINT planning_runs_rule_set_id_cec4d810_fk_rule_sets_id FOREIGN KEY (rule_set_id) REFERENCES public.rule_sets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: provider_availability provider_availabilit_provider_vehicle_id_e3e83254_fk_provider_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability
    ADD CONSTRAINT provider_availabilit_provider_vehicle_id_e3e83254_fk_provider_ FOREIGN KEY (provider_vehicle_id) REFERENCES public.provider_vehicle_offers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: provider_supplier_coverage provider_supplier_co_provider_id_8b56c475_fk_transport; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_supplier_coverage
    ADD CONSTRAINT provider_supplier_co_provider_id_8b56c475_fk_transport FOREIGN KEY (provider_id) REFERENCES public.transport_providers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: provider_supplier_coverage provider_supplier_coverage_supplier_id_411da197_fk_suppliers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_supplier_coverage
    ADD CONSTRAINT provider_supplier_coverage_supplier_id_411da197_fk_suppliers_id FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: provider_vehicle_offers provider_vehicle_off_provider_id_e7eff04a_fk_transport; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_vehicle_offers
    ADD CONSTRAINT provider_vehicle_off_provider_id_e7eff04a_fk_transport FOREIGN KEY (provider_id) REFERENCES public.transport_providers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: provider_vehicle_offers provider_vehicle_off_vehicle_type_id_11dfd4cd_fk_vehicle_t; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_vehicle_offers
    ADD CONSTRAINT provider_vehicle_off_vehicle_type_id_11dfd4cd_fk_vehicle_t FOREIGN KEY (vehicle_type_id) REFERENCES public.vehicle_types(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: receiving_slots receiving_slots_outlet_id_420201a1_fk_outlets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_slots
    ADD CONSTRAINT receiving_slots_outlet_id_420201a1_fk_outlets_id FOREIGN KEY (outlet_id) REFERENCES public.outlets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: receiving_windows receiving_windows_outlet_id_ed952960_fk_outlets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_windows
    ADD CONSTRAINT receiving_windows_outlet_id_ed952960_fk_outlets_id FOREIGN KEY (outlet_id) REFERENCES public.outlets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: rule_sets rule_sets_created_by_id_b256cd5d_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rule_sets
    ADD CONSTRAINT rule_sets_created_by_id_b256cd5d_fk_users_id FOREIGN KEY (created_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_confirmations supplier_confirmatio_commitment_released__ffac5721_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_confirmations
    ADD CONSTRAINT supplier_confirmatio_commitment_released__ffac5721_fk_users_id FOREIGN KEY (commitment_released_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_confirmations supplier_confirmatio_demand_id_c7dbceea_fk_delivery_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_confirmations
    ADD CONSTRAINT supplier_confirmatio_demand_id_c7dbceea_fk_delivery_ FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_confirmations supplier_confirmations_supplier_id_efd4e769_fk_suppliers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_confirmations
    ADD CONSTRAINT supplier_confirmations_supplier_id_efd4e769_fk_suppliers_id FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_item_promises supplier_item_promis_demand_item_id_6da263fd_fk_demand_it; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_item_promises
    ADD CONSTRAINT supplier_item_promis_demand_item_id_6da263fd_fk_demand_it FOREIGN KEY (demand_item_id) REFERENCES public.demand_items(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_item_promises supplier_item_promis_supplier_item_id_28d3bd65_fk_supplier_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_item_promises
    ADD CONSTRAINT supplier_item_promis_supplier_item_id_28d3bd65_fk_supplier_ FOREIGN KEY (supplier_item_id) REFERENCES public.supplier_items(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_item_promises supplier_item_promis_supplier_request_id_8b5ad847_fk_supplier_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_item_promises
    ADD CONSTRAINT supplier_item_promis_supplier_request_id_8b5ad847_fk_supplier_ FOREIGN KEY (supplier_request_id) REFERENCES public.supplier_requests(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_items supplier_items_item_id_c3340e44_fk_items_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_items
    ADD CONSTRAINT supplier_items_item_id_c3340e44_fk_items_id FOREIGN KEY (item_id) REFERENCES public.items(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_items supplier_items_supplier_id_5f2bd780_fk_suppliers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_items
    ADD CONSTRAINT supplier_items_supplier_id_5f2bd780_fk_suppliers_id FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_requests supplier_requests_created_by_id_25c9f9bd_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT supplier_requests_created_by_id_25c9f9bd_fk_users_id FOREIGN KEY (created_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_requests supplier_requests_demand_id_58058ffe_fk_delivery_demands_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT supplier_requests_demand_id_58058ffe_fk_delivery_demands_id FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_requests supplier_requests_supplier_confirmatio_33642ffe_fk_supplier_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT supplier_requests_supplier_confirmatio_33642ffe_fk_supplier_ FOREIGN KEY (supplier_confirmation_id) REFERENCES public.supplier_confirmations(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: supplier_requests supplier_requests_supplier_id_99cffd50_fk_suppliers_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_requests
    ADD CONSTRAINT supplier_requests_supplier_id_99cffd50_fk_suppliers_id FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transport_handover_responses transport_handover_r_handover_id_b8cde20b_fk_transport; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handover_responses
    ADD CONSTRAINT transport_handover_r_handover_id_b8cde20b_fk_transport FOREIGN KEY (handover_id) REFERENCES public.transport_handovers(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transport_handover_responses transport_handover_responses_actor_id_f47b9821_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handover_responses
    ADD CONSTRAINT transport_handover_responses_actor_id_f47b9821_fk_users_id FOREIGN KEY (actor_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transport_handovers transport_handovers_actor_id_5425f563_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handovers
    ADD CONSTRAINT transport_handovers_actor_id_5425f563_fk_users_id FOREIGN KEY (actor_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: transport_handovers transport_handovers_plan_id_ac21642e_fk_final_plans_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_handovers
    ADD CONSTRAINT transport_handovers_plan_id_ac21642e_fk_final_plans_id FOREIGN KEY (plan_id) REFERENCES public.final_plans(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: user_outlet_access user_outlet_access_assigned_by_id_4c83bab5_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_outlet_access
    ADD CONSTRAINT user_outlet_access_assigned_by_id_4c83bab5_fk_users_id FOREIGN KEY (assigned_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: user_outlet_access user_outlet_access_outlet_id_cda08970_fk_outlets_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_outlet_access
    ADD CONSTRAINT user_outlet_access_outlet_id_cda08970_fk_outlets_id FOREIGN KEY (outlet_id) REFERENCES public.outlets(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: user_outlet_access user_outlet_access_user_id_ad9e1957_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_outlet_access
    ADD CONSTRAINT user_outlet_access_user_id_ad9e1957_fk_users_id FOREIGN KEY (user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: user_roles user_roles_assigned_by_id_a9db12d1_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_assigned_by_id_a9db12d1_fk_users_id FOREIGN KEY (assigned_by_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: user_roles user_roles_role_id_816a4486_fk_roles_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_816a4486_fk_roles_id FOREIGN KEY (role_id) REFERENCES public.roles(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: user_roles user_roles_user_id_9d9f8dbb_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_9d9f8dbb_fk_users_id FOREIGN KEY (user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: users_groups users_groups_group_id_2f3517aa_fk_auth_group_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_groups
    ADD CONSTRAINT users_groups_group_id_2f3517aa_fk_auth_group_id FOREIGN KEY (group_id) REFERENCES public.auth_group(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: users_groups users_groups_user_id_f500bee5_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_groups
    ADD CONSTRAINT users_groups_user_id_f500bee5_fk_users_id FOREIGN KEY (user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: users_user_permissions users_user_permissio_permission_id_6d08dcd2_fk_auth_perm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_user_permissions
    ADD CONSTRAINT users_user_permissio_permission_id_6d08dcd2_fk_auth_perm FOREIGN KEY (permission_id) REFERENCES public.auth_permission(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: users_user_permissions users_user_permissions_user_id_92473840_fk_users_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_user_permissions
    ADD CONSTRAINT users_user_permissions_user_id_92473840_fk_users_id FOREIGN KEY (user_id) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: vehicle_cargo_compatibility vehicle_cargo_compat_cargo_category_id_fdcd1c35_fk_cargo_cat; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_cargo_compatibility
    ADD CONSTRAINT vehicle_cargo_compat_cargo_category_id_fdcd1c35_fk_cargo_cat FOREIGN KEY (cargo_category_id) REFERENCES public.cargo_categories(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: vehicle_cargo_compatibility vehicle_cargo_compat_vehicle_type_id_86df483f_fk_vehicle_t; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_cargo_compatibility
    ADD CONSTRAINT vehicle_cargo_compat_vehicle_type_id_86df483f_fk_vehicle_t FOREIGN KEY (vehicle_type_id) REFERENCES public.vehicle_types(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: wave_demands wave_demands_demand_id_3b193838_fk_delivery_demands_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wave_demands
    ADD CONSTRAINT wave_demands_demand_id_3b193838_fk_delivery_demands_id FOREIGN KEY (demand_id) REFERENCES public.delivery_demands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: wave_demands wave_demands_wave_id_323342a0_fk_delivery_waves_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wave_demands
    ADD CONSTRAINT wave_demands_wave_id_323342a0_fk_delivery_waves_id FOREIGN KEY (wave_id) REFERENCES public.delivery_waves(id) DEFERRABLE INITIALLY DEFERRED;


--
-- PostgreSQL database dump complete
--

\unrestrict Ik49dWbBQWEmDeGtHNviW3rZvVvkU75D6cNt9eRF96tz9qruiqCRlz4Xpk6oMmL

