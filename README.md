# Lead Qualification Pipeline

> Webhook-driven lead intake for HubSpot — deduplicates contacts, scores by fit and urgency, and routes them to the right action without double-firing on returning leads.

---

## What It Does

When HubSpot fires a webhook on contact create or update, this workflow:

1. Extracts contact data from the event payload
2. Checks Supabase for an existing record by email
3. **New lead** — inserts the record, sets `touch_count = 1`, flags `is_new_lead = true`
4. **Returning lead** — updates the record, increments `touch_count`, flags `is_new_lead = false`
5. Calculates a **fit score** (0–100) and **urgency score** (0–100) from contact properties
6. Routes by fit tier — high, medium, or low — but only creates outreach actions for new leads
7. Logs the score to Supabase and returns `200 OK` to HubSpot

The `is_new_lead` flag is the key design decision. A contact who refills your form, gets imported twice, or triggers multiple webhook events should only ever generate one call alert and one nurture enrollment. Everything else just gets scored and logged.

---

## Architecture

```
HubSpot Webhook (contact create / property change)
    ↓
Extract Lead Data
    ↓
Query Supabase by Email
    ├──→ [Exists]  → Update record, increment touch_count, is_new_lead = false
    └──→ [New]     → Insert record, touch_count = 1, is_new_lead = true
    ↓
Calculate Fit + Urgency Scores
    ↓
Insert Score (Supabase)
    ↓
Route by Fit Tier
    ├──→ High (≥ 80)  → IF is_new_lead → Slack alert to sales rep
    ├──→ Medium (≥ 50) → IF is_new_lead → Add to nurture queue
    └──→ Low (< 50)   → IF is_new_lead → Manual review queue
    ↓
Respond 200 OK

Error Trigger → Log to Supabase → Slack error alert
```

---

## Scoring Logic

Scoring is rule-based JavaScript — explicit weights, no AI. It's intentionally transparent: change the weights, change the behavior.

### Fit Score (0–100) — how good is this lead for the business

| Component | Max | Signal |
|---|---|---|
| Company size | 30 | 1000+ = 30 pts, scales down to 3 pts for 1–9 employees |
| Job title / seniority | 40 | C-level/Founder = 40, VP/Director = 32, Manager = 18, IC = 6 |
| Deal size potential | 30 | $100K+ = 30 pts, scales down to 6 pts for <$10K |

### Urgency Score (0–100) — how fast to act

| Component | Max | Signal |
|---|---|---|
| Lead source | 40 | Referral/demo request = 38–40, organic = 28, cold = 8–14 |
| Conversion signals | 35 | Type of conversion + recency bonus |
| Timing | 25 | Real-time webhook = full 25 pts |

### Routing thresholds

| Fit | Action | Channel |
|---|---|---|
| ≥ 80 | `call_now` | Slack alert to sales |
| 50–79 | `nurture_sequence` | Email queue |
| < 50 | `manual_review` | Logged, no outreach |

---

## Prerequisites

- n8n instance (self-hosted or cloud)
- HubSpot with webhook subscriptions on contact properties (`email`, `firstname`, `lastname`, `company`, `jobtitle`, `hs_analytics_source`, `lifecyclestage`)
- Supabase project with the schema below
- Slack bot with `chat:write` scope

**Works best downstream of [HubSpot Data Normalization Engine](https://github.com/scottcollier10/hubspot-data-normalization).** The scoring logic regex-matches raw job titles and company names — normalized `canon_seniority` and `canon_employee_band` fields make it significantly more accurate.

### Supabase Schema

```sql
CREATE TABLE leads (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  dedup_key TEXT UNIQUE NOT NULL,
  name TEXT, phone TEXT, company TEXT, domain TEXT, message TEXT,
  source TEXT DEFAULT 'hubspot',
  touch_count INTEGER DEFAULT 1,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE scores (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  fit INTEGER NOT NULL CHECK (fit BETWEEN 0 AND 100),
  urgency INTEGER NOT NULL CHECK (urgency BETWEEN 0 AND 100),
  reason TEXT,
  model TEXT DEFAULT 'rule-based-v1',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE actions (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  channel TEXT,
  status TEXT DEFAULT 'queued',
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workflow_errors (
  id BIGSERIAL PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  lead_id BIGINT,
  error_message TEXT,
  error_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Quick Start

1. Import `lead-qualification-production-v1.json` into n8n
2. Create credentials — Supabase HTTP Header Auth (`apikey: YOUR_SERVICE_ROLE_KEY`) and Slack OAuth2
3. Update the Slack user ID in the **"Send Slack Alert"** node
4. Configure HubSpot webhook to POST to `https://YOUR_N8N_DOMAIN/webhook/hubspot-lead-webhook-dd`
5. Test with a curl request, verify Supabase rows, activate

```bash
curl -X POST https://YOUR_N8N_DOMAIN/webhook/hubspot-lead-webhook-dd \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","properties":{"firstname":{"value":"Test"},"company":{"value":"Acme"},"jobtitle":{"value":"VP Marketing"},"numberofemployees":{"value":"500"},"hs_analytics_source":{"value":"ORGANIC_SEARCH"}}}'
```

---

## Extending

**Swap to AI scoring** — replace the `Calculate Scores` Code node with a Claude API call. The rest of the workflow (dedup, routing, logging) stays identical. The `model` and `prompt_version` fields in the scores table are already there for this.

**Write scores back to HubSpot** — add an HTTP Request PATCH after score insert targeting `https://api.hubapi.com/crm/v3/objects/contacts/{id}` with custom properties for fit score, urgency score, and qualification tier.

**Connect normalization upstream** — update `Extract Lead Data` to prefer `canon_seniority` and `canon_employee_band` over raw `jobtitle` and `numberofemployees` when present.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Workflow runtime | n8n |
| Database | Supabase (PostgreSQL) |
| CRM source | HubSpot Webhooks |
| Alerts | Slack |
| Scoring | JavaScript (Code node) |

---

## Related Projects

- **[HubSpot Data Normalization Engine](https://github.com/scottcollier10/hubspot-data-normalization)** — Cleans messy contact fields into canonical form. Run this upstream for significantly better scoring accuracy.
- **[Content Generator](https://github.com/scottcollier10/content-generator)** — Generates personalized email variations via Slack. Use downstream to build nurture sequences for medium-tier leads.

---

*Built by [Scott Collier](https://github.com/scottcollier10)*
