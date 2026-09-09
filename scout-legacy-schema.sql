--
-- PostgreSQL database dump
--

\restrict Y3d919eAy02AxVFgW9bbqvKGwt5u5w2C4eowTWjeVAwPniV2fcd9bm2dNdcMkev

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: scout_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    extract_date date NOT NULL,
    claim_no text NOT NULL,
    handler_email text,
    handler_name text,
    insured_name text,
    insured_masked text,
    status text,
    age_days integer,
    peril text,
    peril_type text,
    insurer text,
    outstanding numeric,
    description text,
    dol date,
    registered_date date,
    comments text,
    priority_score integer DEFAULT 0,
    priority_flags jsonb,
    recommended_action text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: scout_extracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_extracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    extract_date date NOT NULL,
    uploaded_by text NOT NULL,
    claim_count integer,
    file_name text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: scout_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    role text NOT NULL,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    portal text DEFAULT 'claims'::text NOT NULL,
    CONSTRAINT scout_users_portal_check CHECK ((portal = ANY (ARRAY['claims'::text, 'underwriting'::text, 'both'::text]))),
    CONSTRAINT scout_users_role_check CHECK ((role = ANY (ARRAY['handler'::text, 'manager'::text, 'admin'::text, 'viewer'::text])))
);


--
-- Name: scout_claims scout_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_claims
    ADD CONSTRAINT scout_claims_pkey PRIMARY KEY (id);


--
-- Name: scout_extracts scout_extracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_extracts
    ADD CONSTRAINT scout_extracts_pkey PRIMARY KEY (id);


--
-- Name: scout_users scout_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_users
    ADD CONSTRAINT scout_users_email_key UNIQUE (email);


--
-- Name: scout_users scout_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_users
    ADD CONSTRAINT scout_users_pkey PRIMARY KEY (id);


--
-- Name: idx_claims_extract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_claims_extract ON public.scout_claims USING btree (extract_date);


--
-- Name: idx_claims_handler; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_claims_handler ON public.scout_claims USING btree (handler_email);


--
-- Name: idx_claims_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_claims_status ON public.scout_claims USING btree (status);


--
-- Name: scout_users Authenticated users can read users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read users" ON public.scout_users FOR SELECT USING (true);


--
-- Name: scout_extracts Authenticated users read extracts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users read extracts" ON public.scout_extracts FOR SELECT USING (true);


--
-- Name: scout_claims Handlers see own claims; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Handlers see own claims" ON public.scout_claims FOR SELECT USING (((handler_email = ((current_setting('request.jwt.claims'::text, true))::jsonb ->> 'email'::text)) OR (((current_setting('request.jwt.claims'::text, true))::jsonb ->> 'role'::text) = ANY (ARRAY['manager'::text, 'admin'::text, 'viewer'::text]))));


--
-- Name: scout_users Service role manages users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role manages users" ON public.scout_users USING (false);


--
-- Name: scout_claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_extracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_extracts ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_users ENABLE ROW LEVEL SECURITY;

--
-- Name: TABLE scout_claims; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.scout_claims TO anon;
GRANT ALL ON TABLE public.scout_claims TO authenticated;
GRANT ALL ON TABLE public.scout_claims TO service_role;


--
-- Name: TABLE scout_extracts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.scout_extracts TO anon;
GRANT ALL ON TABLE public.scout_extracts TO authenticated;
GRANT ALL ON TABLE public.scout_extracts TO service_role;


--
-- Name: TABLE scout_users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.scout_users TO anon;
GRANT ALL ON TABLE public.scout_users TO authenticated;
GRANT ALL ON TABLE public.scout_users TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict Y3d919eAy02AxVFgW9bbqvKGwt5u5w2C4eowTWjeVAwPniV2fcd9bm2dNdcMkev
