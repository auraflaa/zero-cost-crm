# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **AI Voice-to-Lead Ingestion**: Microphone recording and audio upload transcription via Whisper (`whisper-large-v3-turbo`) with structured prospect JSON extraction (`POST /api/import/voice/extract`).
- **AI Image & Business Card OCR**: Multimodal vision extraction (`POST /api/import/image/extract`) supporting business card photo upload, direct mobile camera capture (`capture="environment"`), and combined photo + voice notes.
- **Multi-Format Prospect Ingestion**: Auto-delimiter parser supporting CSV, TSV, Excel (`.xlsx`, `.xls`), JSON, HTML, XML, Markdown tables, and raw text.
- **AI ICP Lead Scoring (0–10 Scale)**: Automated lead scoring against configurable ICP description in Settings (`POST /api/ai/score` & `POST /api/companies/:id/score`), background scoring daemon for unscored companies, score badges and reasons in Contacts, Pipeline Kanban, and Company modal with a "Rescore with AI" action.
- **Call Recording Intelligence**: Whisper speech-to-text and automated ICP transcript analysis for SDR calls.
- **Subscription Management & Feature Gating**: Dedicated Subscription page (`plus`, `pro`, `enterprise` tiers), plan switcher, feature comparison, and `402 Payment Required` middleware gating AI features behind Pro/Enterprise.
- **Contact Descriptions**: Added `description` and `raw_input_text` fields across database, API, and ContactForm.
- **API Spec & Docs**: Full OpenAPI 3.1 synchronization (`openapi.yaml`) and updated API documentation (`docs/API.md`).
- **Test Coverage**: Added unit tests for lead scoring and subscriptions, along with functional API test suites for subscription endpoints and scoring.

### Changed

- Instance `app_settings` table for branding, pipeline stages, contact statuses, ICP description, and subscription plan.
- `GET /api/config` now returns `brandName`, `brandTagline`, `logoUrl`, `stages`, `contactStatuses`, `championStatusToStage`, `discoveryQuestions`, `icpDescription`, and `subscriptionPlan`.
- `PATCH /api/settings` (admin/founder) to update instance settings including ICP description.
- Settings page in the UI for founders/admins with ICP configuration.
- Replaced native browser confirmation alerts with styled modal dialogs.

## [1.1.0] — 2026-07-17

### Changed

- Renamed the product from “SDR War Room” to **Zero Cost CRM** across UI, docs, package metadata, and schema comments
- Package name is now `zero-cost-crm`

## [1.0.0] — 2026-07-17

### Added

- Open-source readiness: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, Dependabot, and CI
- Public `/api/config` for email-domain policy
- Architecture and API documentation under `docs/`
- Helmet security headers and login rate limiting
- Configurable `ALLOWED_EMAIL_DOMAIN`, `CORS_ORIGINS`, and required AWS bucket/region for recordings

### Changed

- Replaced vulnerable `xlsx` dependency with `exceljs` (+ native CSV/TSV parsing)
- JWT secret is required outside explicit test seed mode (no production fallback)
- Sample import / smoke-test data uses synthetic `@*.example` identities
- Repository metadata points at `ConvoBrains/zero-cost-crm`

### Security

- Removed hardcoded production S3 bucket default
- Documented credential rotation for any secrets that ever lived in git history
