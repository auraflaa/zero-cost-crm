# Zero Cost CRM — Comprehensive Setup & Operations Guide

This guide walks you through setting up, developing, configuring, testing, and deploying **Zero Cost CRM** in any environment (Local Docker, Bare Metal, Remote Database, or Production Cloud).

---

## Table of Contents

1. [System Requirements & Prerequisites](#1-system-requirements--prerequisites)
2. [Architecture at a Glance](#2-architecture-at-a-glance)
3. [Quickstart with Docker (Recommended)](#3-quickstart-with-docker-recommended)
4. [Bare Metal Local Development](#4-bare-metal-local-development)
5. [Local Development against Remote/Live RDS (SSH Tunnel)](#5-local-development-against-remotelive-rds-ssh-tunnel)
6. [Environment Variables Reference](#6-environment-variables-reference)
7. [Database Setup & Migrations](#7-database-setup--migrations)
8. [AI Integrations & Provider Setup](#8-ai-integrations--provider-setup)
9. [Running Tests & Quality Checks](#9-running-tests--quality-checks)
10. [Production Deployment](#10-production-deployment)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)

---

## 1. System Requirements & Prerequisites

Ensure the following tools are installed on your machine:

| Tool                        | Minimum Version | Notes                                                     |
| :-------------------------- | :-------------- | :-------------------------------------------------------- |
| **Node.js**                 | `v22.0.0+`      | Recommended LTS. Verify with `node -v`                    |
| **npm**                     | `v10.0.0+`      | Comes bundled with Node.js. Verify with `npm -v`          |
| **Docker & Docker Compose** | `v24.0+`        | Required for containerized runtime & test DB              |
| **Git**                     | `v2.30+`        | Version control. Verify with `git --version`              |
| **PostgreSQL (Optional)**   | `16+`           | Required only if running native PostgreSQL without Docker |
| **Make (Optional)**         | `v3.81+`        | Optional helper for running Makefile shortcuts            |

---

## 2. Architecture at a Glance

```text
┌────────────────────────────────────────────────────────┐
│               Frontend (React 19 + Vite)              │
│       SPA with Kanban, Tables, Activity & Analytics    │
│                 (Port 5173 in dev)                     │
└───────────────────────────┬────────────────────────────┘
                            │ /api/* (JSON + JWT)
┌───────────────────────────▼────────────────────────────┐
│               Backend (Express 5 + TypeScript)          │
│    Auth, CRM CRUD, Multi-format Import, S3 Presigner,   │
│         Subscription Gating, Background AI Worker       │
│                 (Port 4000 in dev)                     │
└───────────────────────────┬────────────────────────────┘
                            │ SQL Queries & Triggers
┌───────────────────────────▼────────────────────────────┐
│                 PostgreSQL 16 Database                 │
│      Companies, Contacts, SDR Sessions, App Settings,  │
│         Lead Scores, Conversations, Extraction Jobs     │
│                 (Port 5432 / 5434)                     │
└────────────────────────────────────────────────────────┘
```

In production, Express serves the compiled React application directly from `dist/`.

---

## 3. Quickstart with Docker (Recommended)

Get a fully functional local instance up and running in under 2 minutes with pre-seeded demo data.

### Step 1: Clone the Repository

```bash
git clone https://github.com/auraflaa/zero-cost-crm.git
cd zero-cost-crm
```

### Step 2: Initialize & Start Containers

If you have `make` installed:

```bash
make setup && make dev
```

Alternatively, using standard Docker and npm commands:

```bash
# Copy demo environment configuration
cp testing/functional/.env.testing.example testing/functional/.env.testing

# Start demo PostgreSQL and prepare database schema + fixtures
docker compose -f testing/functional/docker-compose.yml up -d
npm install
npm run test:api:prep

# Launch Vite client and Express API concurrently
npm run dev
```

### Step 3: Access the Application

Open your browser and navigate to **[http://localhost:5173](http://localhost:5173)** (or **[http://localhost:4000](http://localhost:4000)** if running via Docker Compose).

#### Default Demo Credentials:

```text
Email:    founder.seed@convobrains.com
Password: TestSeed123!
```

> **Note:** The demo seed comes loaded with 3 days of realistic SDR activity, contacts, company records, and sample pipeline stages.

---

## 4. Bare Metal Local Development

Follow these steps if you prefer to run PostgreSQL natively on your host without Docker.

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Create PostgreSQL Database

Create a database and user in your local PostgreSQL server:

```sql
CREATE USER crm_dev WITH PASSWORD 'devpassword123';
CREATE DATABASE brains_crm_dev OWNER crm_dev;
GRANT ALL PRIVILEGES ON DATABASE brains_crm_dev TO crm_dev;
```

### Step 3: Configure Environment Variables

Create `.env.local` in the project root:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your database connection:

```env
PORT=4000
DATABASE_URL=postgresql://crm_dev:devpassword123@localhost:5432/brains_crm_dev
JWT_SECRET=super-secret-random-key-at-least-32-chars-long!
ALLOWED_EMAIL_DOMAIN=*
CORS_ORIGINS=http://localhost:5173,http://localhost:4000
SUBSCRIPTION_PLAN=pro
```

### Step 4: Apply Database Schema & Seed Data

```bash
# Run schema migrations
npm run db:migrate

# (Optional) Seed demo users and mock activity
node testing/functional/prepare.mjs
```

### Step 5: Start Development Servers

```bash
# Runs Vite (:5173) and Express API (:4000) concurrently with hot-reloading
npm run dev
```

---

## 5. Local Development against Remote/Live RDS (SSH Tunnel)

To test changes against an external staging or live RDS PostgreSQL database securely through an SSH jump host:

### Step 1: Establish SSH Tunnel

Forward your local port `5433` to the remote RDS instance port `5432`:

```bash
ssh -N -L 5433:<rds-endpoint-host>:5432 <ec2-user>@<jump-host-ip>
```

_Keep this terminal open in the background._

### Step 2: Configure Environment

Create `.env.local`:

```env
PORT=4000
DATABASE_URL=postgresql://<db-user>:<db-password>@localhost:5433/brains_crm_int
DB_SSL=true
JWT_SECRET=<matching-remote-jwt-secret>
ALLOWED_EMAIL_DOMAIN=convobrains.com
SUBSCRIPTION_PLAN=pro
```

### Step 3: Run Database Cutover & Migration

```bash
chmod +x scripts/local-against-live.sh
./scripts/local-against-live.sh
```

### Step 4: Launch Local Client

```bash
npm run dev
```

Open **[http://localhost:5173](http://localhost:5173)** and log in with your authorized remote domain credentials.

---

## 6. Environment Variables Reference

| Variable                | Required | Default                                          | Purpose & Description                                                                            |
| :---------------------- | :------: | :----------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | **Yes**  | —                                                | PostgreSQL connection URI (`postgresql://user:pass@host:port/dbname`).                           |
| `DB_SSL`                |    No    | `false`                                          | Set to `true` or `require` for managed cloud databases (AWS RDS, Neon, Supabase).                |
| `JWT_SECRET`            | **Yes**  | —                                                | Secret string used for signing and verifying JSON Web Tokens (min 32 chars).                     |
| `PORT`                  |    No    | `4000`                                           | HTTP port where the Express backend listens.                                                     |
| `ALLOWED_EMAIL_DOMAIN`  |    No    | `*`                                              | Email whitelist domain (`convobrains.com`, comma-separated list, or `*` for open signups).       |
| `CORS_ORIGINS`          |    No    | `*`                                              | Comma-separated list of allowed browser origins (`http://localhost:5173,http://localhost:4000`). |
| `SUBSCRIPTION_PLAN`     |    No    | `pro`                                            | Default active tier (`free`, `plus`, `pro`, `enterprise`).                                       |
| `AI_PROVIDER`           |    No    | `groq`                                           | AI provider for STT/OCR/Scoring (`groq`, `openai`, `gemini`, `anthropic`, `deepseek`, `ollama`). |
| `AI_API_KEY`            |    No    | —                                                | API key for the chosen AI provider.                                                              |
| `AI_MODEL`              |    No    | `llama-3.3-70b-versatile`                        | LLM model identifier for ICP lead scoring.                                                       |
| `STT_MODEL`             |    No    | `whisper-large-v3`                               | Speech-to-Text model for audio notes and call recordings.                                        |
| `VISION_MODEL`          |    No    | `llama-3.2-11b-vision-preview`                   | Vision model for business card OCR extraction.                                                   |
| `AWS_REGION`            |    No    | `us-east-1`                                      | AWS region for S3 call recording storage.                                                        |
| `AWS_ACCESS_KEY_ID`     |    No    | —                                                | AWS IAM Access Key ID for S3 upload presigning.                                                  |
| `AWS_SECRET_ACCESS_KEY` |    No    | —                                                | AWS IAM Secret Key for S3 upload presigning.                                                     |
| `AWS_S3_BUCKET`         |    No    | —                                                | S3 bucket name for audio call recordings.                                                        |
| `BRAND_NAME`            |    No    | `Zero Cost CRM`                                  | Brand name seeded on initial database boot.                                                      |
| `BRAND_TAGLINE`         |    No    | `Salesforce for teams that still live in Sheets` | Default brand tagline.                                                                           |
| `ICP_DESCRIPTION`       |    No    | —                                                | Custom Ideal Customer Profile text for lead scoring.                                             |

---

## 7. Database Setup & Migrations

### Idempotent Schema

The database schema is defined in [`sql/schema.sql`](sql/schema.sql). It is completely idempotent and safe to re-run across updates.

It provisions:

- `users` (id, email, password_hash, role, full_name, is_active)
- `companies` (pipeline stage, lead_score, discovery_answers, intent, call volume, etc.)
- `contacts` (champion flag, status, last_contacted, next_follow_up, etc.)
- `conversations` (audio S3 keys, duration, transcripts, AI analysis)
- `user_sessions` & `activity_events` (SDR metrics, logins, active time, dial counts)
- `app_settings` (instance branding, custom stages, contact statuses, discovery questions, ICP description, subscription plan)
- `lead_scores` (historical 0–10 score logs with detailed analysis rationale)
- `extraction_jobs` (audit trail for multimodal voice & image lead extractions)

### Running Migrations

To execute the migration script:

```bash
npm run db:migrate
```

### Resetting Demo Data

To wipe and rebuild fresh local test fixtures:

```bash
make reset-demo
# or manually:
node testing/functional/prepare.mjs
```

---

## 8. AI Integrations & Provider Setup

Zero Cost CRM supports multi-provider AI out of the box for Voice STT, Business Card OCR, and Lead Scoring.

### Provider Matrix

| Feature           | Groq (Fastest / Free Tier)     | OpenAI               | Google Gemini      | Local / Ollama      |
| :---------------- | :----------------------------- | :------------------- | :----------------- | :------------------ |
| **Voice STT**     | `whisper-large-v3`             | `whisper-1`          | Gemini Audio       | Local Whisper       |
| **Card OCR**      | `llama-3.2-11b-vision-preview` | `gpt-4o-mini`        | `gemini-1.5-flash` | LLaVA / Ollama      |
| **ICP Scoring**   | `llama-3.3-70b-versatile`      | `gpt-4o-mini`        | `gemini-1.5-flash` | `llama3.2`          |
| **Call Analysis** | `whisper-large-v3` + LLaMA     | `whisper-1` + GPT-4o | Gemini Multimodal  | Whisper + Local LLM |

### Enabling Groq (Recommended for Speed & Cost)

Add to your `.env.local`:

```env
AI_PROVIDER=groq
AI_API_KEY=gsk_your_groq_api_key_here
AI_MODEL=llama-3.3-70b-versatile
STT_MODEL=whisper-large-v3
VISION_MODEL=llama-3.2-11b-vision-preview
```

### Enabling OpenAI

```env
AI_PROVIDER=openai
AI_API_KEY=sk-proj-your_openai_key_here
AI_MODEL=gpt-4o-mini
STT_MODEL=whisper-1
VISION_MODEL=gpt-4o-mini
```

---

## 9. Running Tests & Quality Checks

Zero Cost CRM enforces strict test-driven development across unit, API, and E2E suites.

### 1. Unit Tests (Vitest)

Fast in-memory testing for frontend logic, URL normalization, lead scoring math, and stores:

```bash
npm test
```

### 2. Functional API Tests (Vitest + PostgreSQL)

Tests real HTTP requests against a running PostgreSQL test container (`brains_crm_test` on port `5434`):

```bash
npm run test:api
```

### 3. End-to-End Browser Tests (Playwright)

Validates UI interactions, drag-and-drop Kanban moves, modals, and forms:

```bash
# First time only: install browser binaries
npm run test:e2e:install

# Run Playwright test suite
npm run test:e2e
```

### 4. Linting & Formatting

```bash
# Run oxlint checks
npm run lint

# Check code formatting with Prettier
npm run format:check

# Auto-fix formatting
npm run format
```

---

## 10. Production Deployment

### Option A: Docker / VPS Deployment

The repository includes a production-ready [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml).

1. Clone the repository on your production server.
2. Create `.env` with production secrets (`DATABASE_URL`, `JWT_SECRET`, `ALLOWED_EMAIL_DOMAIN`, etc.).
3. Build and launch the container:
   ```bash
   docker compose up -d --build
   ```
4. Verify backend health:
   ```bash
   curl http://localhost:4000/api/health
   # Returns: {"ok":true}
   ```

### Option B: Reverse Proxy with NGINX & SSL

Sample NGINX configuration snippet:

```nginx
server {
    server_name crm.yourcompany.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 50M;
    }
}
```

### Option C: Vercel + Managed PostgreSQL (Neon / Supabase)

1. Link your GitHub repository to Vercel.
2. In Vercel Project Settings, set Environment Variables (`DATABASE_URL`, `JWT_SECRET`, `ALLOWED_EMAIL_DOMAIN`, `DB_SSL=true`).
3. Run migrations on your remote database:
   ```bash
   DATABASE_URL="postgresql://..." npm run db:migrate
   ```
4. Deploy the project. The configuration in [vercel.json](vercel.json) automatically routes `/api/*` to the serverless entrypoint and serves the static React SPA.

---

## 11. Troubleshooting & FAQ

### Q: `invalid input syntax for type uuid: ""` or Date format error when saving contacts/companies

**Fix:** Ensure empty optional fields are converted to `null` on the server. The latest API patch sanitizes empty strings before writing to PostgreSQL.

### Q: Docker port 5432 or 4000 already in use

**Fix:** Either stop the conflicting process or map to an alternative port in your `.env.local` / `docker-compose.yml` (e.g. `PORT=4001`).

### Q: Error: "Registration domain not allowed"

**Fix:** Set `ALLOWED_EMAIL_DOMAIN=*` in your `.env.local` for development, or set it to your organization's domain (e.g. `convobrains.com`).

### Q: Audio or image uploads return 400 or fail

**Fix:** Audio files must be valid audio formats (`audio/wav`, `audio/mpeg`, `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/x-m4a`). Images must be `image/jpeg`, `image/png`, or `image/webp`.

### Q: How do I change the pipeline stages or branding?

**Fix:** Log in as an admin or founder, open **Settings** from the sidebar, edit your stages/brand, and click **Save Changes**. The changes persist in the database `app_settings` table.

---

## Useful References

- [Architecture Guide](docs/ARCHITECTURE.md)
- [HTTP API Reference](docs/API.md)
- [OpenAPI 3.1 Specification](openapi.yaml)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
