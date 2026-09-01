# Zero Cost CRM

[![CI](https://github.com/auraflaa/zero-cost-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/auraflaa/zero-cost-crm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Good first issues](https://img.shields.io/github/labels/auraflaa/zero-cost-crm/good%20first%20issue)](https://github.com/auraflaa/zero-cost-crm/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
[![GitHub stars](https://img.shields.io/github/stars/auraflaa/zero-cost-crm?style=social)](https://github.com/auraflaa/zero-cost-crm/stargazers)
[![first-timers-only](https://img.shields.io/badge/first--timers--only-friendly-blue.svg?style=flat-square)](https://www.firsttimersonly.com/)

**Salesforce for teams that still live in Sheets** — self-hosted sales pipeline, contacts, follow-up discipline, SDR activity tracking, multimodal AI lead ingestion, and sales call conversation intelligence. MIT licensed. One command to run.

---

## ⚡ Quick Navigation

- 📖 **[Detailed Setup Guide](SETUP.md)** — Complete step-by-step local, Docker, RDS, and production setup.
- 🏗️ **[Architecture Overview](docs/ARCHITECTURE.md)** — High-level design, database ER sketches, and data flow.
- 🔌 **[HTTP API Documentation](docs/API.md)** — Endpoints, auth headers, parameters, and payloads.
- 📄 **[OpenAPI 3.1 Contract](openapi.yaml)** — Machine-readable API schema.
- 🗄️ **[Database Schema](sql/schema.sql)** — Production-ready idempotent PostgreSQL schema.
- 🤝 **[Contributing Guidelines](CONTRIBUTING.md)** — How to claim tickets, develop features, and submit PRs.
- 🔒 **[Security Policy](SECURITY.md)** — Vulnerability disclosure guidelines.
- 🌐 **[Book a Demo with Founders](https://www.convobrains.com/contact)** — Custom onboarding & conversation intelligence.

---

## Why Zero Cost CRM?

Most early-stage B2B sales teams hire their first 1–5 SDRs and manage them across messy Google Sheets, chaotic WhatsApp threads, and founder intuition. Paying thousands per rep for Salesforce or HubSpot is overkill.

**Zero Cost CRM gives you:**

1. A **13-stage customizable sales pipeline** that reps actually use.
2. **Follow-up discipline** — connected calls without next steps light up as manager alerts.
3. **AI Lead Scoring (0–10)** against your company's custom Ideal Customer Profile (ICP) with actionable analysis notes.
4. **Multimodal Lead Ingestion** — record a quick voice memo or snap a photo of a business card to automatically populate structured contacts and companies.
5. **Call recording intelligence** attached directly to contacts and companies.
6. **SDR activity visibility** — real logins, active time, dial counts, and outcome tracking.
7. **Zero vendor lock-in** — 100% self-hosted PostgreSQL database under your control.

> **Zero Cost CRM** tells you _what_ happened.  
> **ConvoBrains Intelligence** tells you _why_ it happened.

---

## Features at a Glance

| Feature                       | Description                                                                                           |
| :---------------------------- | :---------------------------------------------------------------------------------------------------- |
| 📊 **Interactive Pipeline**   | 13-stage drag-and-drop Kanban view with stage filters, summary metrics, and deal values.              |
| 🤖 **AI ICP Lead Scoring**    | Automated 0–10 scoring with detailed rationale against your custom ICP description.                   |
| 🎙️ **Voice AI Extraction**    | Record or upload audio voice notes to extract contact details, intent, and follow-ups automatically.  |
| 📷 **Business Card OCR**      | Multimodal vision AI extracts names, emails, phones, titles, and companies from photos.               |
| 👥 **Contact Management**     | Track champions, custom contact statuses, notes, LinkedIn profiles, and automated pipeline sync.      |
| 📂 **Multi-format Importer**  | Bulk import leads from Excel (`.xlsx`), CSV, TSV, JSON, XML, HTML tables, and Markdown.               |
| 📞 **Call Recordings & STT**  | Upload or record MP3/WAV/WebM audio; auto-transcribe with Whisper and analyze conversation sentiment. |
| ⏱️ **SDR Activity Tracking**  | Logins, active/idle time, dial counts, outcome tracking, and daily target pacing.                     |
| 🚨 **Manager Alerts**         | Immediate flags for reps missing 10:30 AM login, zero connected calls, or missing follow-ups.         |
| ⚙️ **Instance Customization** | Customize branding, logo, pipeline stages, contact statuses, and discovery questions in the DB.       |
| 💎 **Tiered Gating**          | Free Core CRM tier + Plus & Pro AI quota management with downgrade protection.                        |

---

## Quickstart in 3 Steps

### Prerequisites

- [Docker & Docker Compose](https://docs.docker.com/get-docker/)
- [Node.js 22+](https://nodejs.org/)

### 1. Clone & Setup

```bash
git clone https://github.com/auraflaa/zero-cost-crm.git
cd zero-cost-crm
make setup && make dev
```

_(If you do not have `make`, run `cp testing/functional/.env.testing.example testing/functional/.env.testing && docker compose -f testing/functional/docker-compose.yml up -d && npm install && npm run test:api:prep && npm run dev`)_

### 2. Open & Sign In

Navigate to **[http://localhost:5173](http://localhost:5173)** in your browser:

```text
Email:    founder.seed@convobrains.com
Password: TestSeed123!
```

> This demo seed database comes populated with 3 days of realistic SDR activity, companies, and contacts.

### 3. Reset Demo Data Anytime

```bash
make reset-demo
```

👉 _For advanced setup (bare metal PostgreSQL, remote RDS tunneling, AI keys, production deployment), see the complete **[SETUP.md](SETUP.md)**._

---

## The SDR Operating Model

### Daily Rhythm

1. **Morning Brief:** Open the Dashboard; review follow-ups due today and high-priority deals.
2. **Pipeline Kanban:** Advance company cards only when real milestones are met.
3. **Contact Logging:** Update contact status and champion flags after every dial.
4. **Call Intelligence:** Attach call recordings or voice notes for automated STT transcription.
5. **Manager Overview:** Check team activity pacing, active vs. idle hours, and coaching opportunities.

### The 13-Stage Sales Pipeline

```text
Lead Added
  └── Discovery Call Done
        └── Follow-up
              └── Demo Scheduled
                    └── Demo Delivered
                          └── Commercial Proposal Shared
                                └── POC Kickoff
                                      └── Client Data Received
                                            └── POC Delivered
                                                  └── Final Negotiation
                                                        ├── Closed Won
                                                        ├── Closed Lost
                                                        └── Not Interested
```

---

## Technology Stack

```text
┌────────────────────────────────────────────────────────┐
│                   React 19 + TypeScript                │
│       Vite · Tailwind CSS · @dnd-kit (Kanban DnD)      │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP / JSON API
┌───────────────────────────▼────────────────────────────┐
│                  Express 5 API Server                  │
│       TypeScript · tsx · JWT Auth · Helmet · CORS       │
└───────────────────────────┬────────────────────────────┘
                            │ PostgreSQL Wire Protocol
┌───────────────────────────▼────────────────────────────┐
│                 PostgreSQL 16 Database                 │
│       Relational Schema · JSONB Fields · Triggers      │
└───────────────────────────┬────────────────────────────┘
                            │ S3 Presigned URLs (Optional)
┌───────────────────────────▼────────────────────────────┐
│               AWS S3 / Compatible Storage               │
│               Audio Call Recordings & OCR              │
└────────────────────────────────────────────────────────┘
```

---

## Development & Test Commands

| Command              | Description                                                       |
| :------------------- | :---------------------------------------------------------------- |
| `npm run dev`        | Launch Vite frontend (:5173) and Express API (:4000) concurrently |
| `npm test`           | Run fast in-memory unit tests (Vitest)                            |
| `npm run test:api`   | Run integration API tests against test PostgreSQL database        |
| `npm run test:e2e`   | Run Playwright browser UI end-to-end tests                        |
| `npm run build`      | Compile TypeScript and bundle production assets with Vite         |
| `npm run lint`       | Run static code analysis with oxlint                              |
| `npm run format`     | Auto-format source files with Prettier                            |
| `npm run db:migrate` | Execute database migrations against configured `DATABASE_URL`     |

---

## Instance Configuration

Company-specific settings are maintained in environment variables and the `app_settings` database table:

| Setting Area                 | Location       | Description                                                                                                                  |
| :--------------------------- | :------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **Secrets & Keys**           | `.env.local`   | `DATABASE_URL`, `JWT_SECRET`, `AI_API_KEY`, `AI_PROVIDER`, `AWS_*`                                                           |
| **Branding & Logo**          | `app_settings` | Managed via the **Settings** page in the UI or `PATCH /api/settings`                                                         |
| **Custom Stages & Statuses** | `app_settings` | Edit pipeline stages and contact statuses in the **Settings** UI                                                             |
| **Subscription Plan Tier**   | `app_settings` | View and manage plan tiers (`free`, `plus`, `pro`, `enterprise`) in **Subscription**                                         |
| **Discovery Questions**      | `app_settings` | Custom questionnaires configured via API or [`sql/examples/convobrains-settings.sql`](sql/examples/convobrains-settings.sql) |

---

## Contributing

We welcome contributions from the community! Check out our open issues:

- 🏷️ **[Good First Issues](https://github.com/auraflaa/zero-cost-crm/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)** — Perfect for beginners.
- 💡 **[Fun & Showcase Issues](https://github.com/auraflaa/zero-cost-crm/issues?q=is%3Aissue+is%3Aopen+label%3Afun)** — Creative enhancements.
- 📖 Read **[CONTRIBUTING.md](CONTRIBUTING.md)** for our step-by-step PR workflow and contribution guidelines.

---

## License

Released under the **[MIT License](LICENSE)** © 2026 ConvoBrains.

---

**Built with ❤️ by [ConvoBrains](https://www.convobrains.com)**  
_Turn sales conversations into predictable revenue._

[Book a demo](https://www.convobrains.com/contact) · [support@convobrains.com](mailto:support@convobrains.com) · [LinkedIn](https://www.linkedin.com/company/convobrains/)
