import type { Express } from 'express';
import type { Pool } from 'pg';
import { requireAuth, requireAdmin } from './auth.js';
import { mapConversation } from './mappers.js';
import {
  contentTypeForExt,
  copyToFinal,
  deleteObject,
  finalKey,
  headObject,
  keyFromUrl,
  MAX_RECORDING_BYTES,
  normalizeExt,
  objectUrl,
  presignGet,
  presignPut,
  stagingKey,
} from './s3.js';
import { getAppSettings, isAllowedStage } from './settings.js';
import { logActivity } from './activity.js';
import { getObjectBuffer } from './s3.js';
import { transcribeAudioBase64, analyseTranscriptForLead } from './ai/transcribe.js';
import { getCurrentPlan, hasFeature } from './subscription.js';

const CONVERSATION_SELECT = `
  SELECT
    cv.*,
    u.name AS called_by_name,
    ct.contact_name,
    co.company_name
  FROM conversations cv
  JOIN users u ON u.id = cv.called_by
  JOIN contacts ct ON ct.id = cv.contact_id
  JOIN companies co ON co.id = cv.company_id
`;

export function registerConversationRoutes(app: Express, pool: Pool) {
  app.post('/api/conversations/presign', requireAuth, async (req, res) => {
    const contactId = String(req.body.contactId ?? '');
    const fileExt = normalizeExt(String(req.body.fileExt ?? ''));
    const notes = req.body.notes != null ? String(req.body.notes) : null;

    if (!contactId || !fileExt) {
      res.status(400).json({ error: 'contactId and valid fileExt are required' });
      return;
    }

    const { rows: contacts } = await pool.query(
      `SELECT ct.*, co.stage AS company_stage
       FROM contacts ct
       JOIN companies co ON co.id = ct.company_id
       WHERE ct.id = $1`,
      [contactId]
    );
    const contact = contacts[0];
    if (!contact) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    const settings = await getAppSettings();
    const fallbackStage = settings.stages[0] ?? 'Lead Added';
    let stageAtCall = String(req.body.stageAtCall ?? contact.company_stage ?? fallbackStage);
    if (!isAllowedStage(settings, stageAtCall)) stageAtCall = fallbackStage;

    const { rows } = await pool.query(
      `
      INSERT INTO conversations (
        company_id, contact_id, called_by, stage_at_call, file_ext, notes, upload_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING *
      `,
      [contact.company_id, contactId, req.user!.sub, stageAtCall, fileExt, notes]
    );
    const row = rows[0];
    const staging = stagingKey(String(row.id), fileExt);
    let uploadUrl: string;
    try {
      uploadUrl = await presignPut(staging, contentTypeForExt(fileExt));
    } catch (e) {
      // S3 not configured (local dev without AWS) — clean up pending row and signal client to use direct upload
      await pool.query('DELETE FROM conversations WHERE id=$1', [row.id]);
      const msg = e instanceof Error ? e.message : 'S3 not configured';
      res.status(503).json({ error: 'S3 not configured for recordings — use direct upload', details: msg, code: 'S3_MISSING' });
      return;
    }

    res.status(201).json({
      conversationId: row.id,
      uploadUrl,
      stagingKey: staging,
    });
  });

  // Direct upload for phone/local dev without S3 — reuses STT whisper-large-v3-turbo immediately (Pro)
  app.post('/api/conversations/direct', requireAuth, async (req, res) => {
    const planCheck = await getCurrentPlan();
    if (!hasFeature(planCheck, 'call_analysis')) {
      res.status(402).json({ error: 'Call analysis requires Pro plan. Upgrade in Subscription.', code: 'SUBSCRIPTION_REQUIRED', plan: planCheck, requiredPlan: 'pro', feature: 'call_analysis' });
      return;
    }
    const contactId = String(req.body.contactId ?? '');
    const stageAtCallRaw = String(req.body.stageAtCall ?? '');
    const notes = req.body.notes != null ? String(req.body.notes) : null;
    const audioBase64 = String(req.body.audioBase64 ?? '');
    const mimeType = String(req.body.mimeType ?? 'audio/webm');
    if (!contactId || !audioBase64) {
      res.status(400).json({ error: 'contactId and audioBase64 required' });
      return;
    }
    const { rows: contacts } = await pool.query(
      `SELECT ct.*, co.stage AS company_stage, co.company_name, ct.contact_name FROM contacts ct JOIN companies co ON co.id=ct.company_id WHERE ct.id=$1`,
      [contactId]
    );
    const contact = contacts[0];
    if (!contact) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }
    const settings = await getAppSettings();
    const fallbackStage = settings.stages[0] ?? 'Lead Added';
    let stageAtCall = stageAtCallRaw || String(contact.company_stage ?? fallbackStage);
    if (!isAllowedStage(settings, stageAtCall)) stageAtCall = fallbackStage;

    // Transcribe first (whisper-large-v3-turbo), then analyse
    const transcript = await transcribeAudioBase64(audioBase64, mimeType);
    const analysis = await analyseTranscriptForLead(transcript || '', settings.icpDescription ?? '', {
      companyName: String(contact.company_name ?? ''),
      contactName: String(contact.contact_name ?? ''),
      industry: '',
      stage: stageAtCall,
    });

    const calledAt = new Date();
    const { rows } = await pool.query(
      `INSERT INTO conversations (company_id, contact_id, called_by, stage_at_call, file_ext, notes, upload_status, called_at, s3_url, transcript, analysis)
       VALUES ($1,$2,$3,$4,'webm',$5,'completed',$6,$7,$8,$9::jsonb) RETURNING *`,
      [contact.company_id, contactId, req.user!.sub, stageAtCall, notes, calledAt.toISOString(), `direct:${contactId}:${Date.now()}`, transcript ?? '', JSON.stringify(analysis)]
    );
    const insertedId = rows[0].id as string;
    const { rows: full } = await pool.query(`${CONVERSATION_SELECT} WHERE cv.id=$1`, [insertedId]);
    const mapped = mapConversation(full[0]);

    // Update company score from call analysis
    if (mapped.companyId) {
      await pool.query(`UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now() WHERE id=$3`, [
        analysis.score,
        JSON.stringify(analysis.reasons),
        mapped.companyId,
      ]);
      await pool.query(`INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`, [
        mapped.companyId,
        analysis.score,
        JSON.stringify(analysis.reasons),
        settings.icpDescription ?? '',
        'call-direct',
      ]);
      await logActivity({
        userId: req.user!.sub,
        sessionId: req.user!.sid,
        eventType: 'conversation.uploaded',
        entityType: 'conversation',
        entityId: insertedId,
        summary: `Direct recording for ${mapped.contactName} — score ${analysis.score} (${analysis.tier})`,
        payload: { contactId, companyId: mapped.companyId, score: analysis.score },
      });
    }

    res.status(201).json(mapped);
  });

  app.post('/api/conversations/:id/complete', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (row.upload_status === 'completed') {
      const { rows: full } = await pool.query(`${CONVERSATION_SELECT} WHERE cv.id = $1`, [id]);
      res.json(mapConversation(full[0]));
      return;
    }
    if (
      row.called_by !== req.user!.sub &&
      req.user!.role !== 'admin' &&
      req.user!.role !== 'founder'
    ) {
      res.status(403).json({ error: 'Not allowed to complete this upload' });
      return;
    }

    const staging = stagingKey(String(row.id), row.file_ext);
    let head;
    try {
      head = await headObject(staging);
    } catch {
      res.status(400).json({ error: 'Recording not found in storage — upload may have failed' });
      return;
    }
    const size = head.ContentLength ?? 0;
    if (size > MAX_RECORDING_BYTES) {
      await deleteObject(staging).catch(() => {});
      await pool.query('DELETE FROM conversations WHERE id = $1', [id]);
      res.status(400).json({ error: 'Recording exceeds 50 MB limit' });
      return;
    }

    const calledAt = new Date();
    const final = finalKey(String(row.id), row.file_ext, calledAt);
    await copyToFinal(staging, final);
    await deleteObject(staging);
    const s3Url = objectUrl(final);

    try {
      const { rows: updated } = await pool.query(
        `
        UPDATE conversations
        SET called_at = $1, s3_url = $2, upload_status = 'completed', updated_at = now()
        WHERE id = $3
        RETURNING id
        `,
        [calledAt.toISOString(), s3Url, id]
      );
      if (!updated[0]) throw new Error('update failed');
    } catch (e: unknown) {
      await deleteObject(final).catch(() => {});
      const err = e as { code?: string };
      if (err.code === '23505') {
        res.status(409).json({ error: 'Duplicate call at this exact time — please upload again' });
        return;
      }
      throw e;
    }

    const { rows: full } = await pool.query(`${CONVERSATION_SELECT} WHERE cv.id = $1`, [id]);
    const mapped = mapConversation(full[0]);
    await logActivity({
      userId: req.user!.sub,
      sessionId: req.user!.sid,
      eventType: 'conversation.uploaded',
      entityType: 'conversation',
      entityId: String(id),
      summary: `Uploaded recording for ${mapped.contactName}`,
      payload: {
        contactId: mapped.contactId,
        companyId: mapped.companyId,
        name: mapped.contactName,
      },
    });
    res.json(mapped);

    // Background: STT → analyse → update score — only for Pro/Enterprise, non-blocking
    setImmediate(async () => {
      try {
        const planBg = await getCurrentPlan();
        if (!hasFeature(planBg, 'call_analysis')) return;
        let base64 = '';
        try {
          const buf = await getObjectBuffer(final);
          base64 = buf.toString('base64');
        } catch {
          return;
        }
        if (!base64) return;
        const transcript = await transcribeAudioBase64(base64, `audio/${row.file_ext}`);
        if (!transcript) return;
        const settings = await getAppSettings();
        const analysis = await analyseTranscriptForLead(transcript, settings.icpDescription ?? '', {
          companyName: mapped.companyName,
          contactName: mapped.contactName,
          industry: '',
          stage: mapped.stageAtCall,
        });
        await pool.query(`UPDATE conversations SET transcript=$1, analysis=$2::jsonb, updated_at=now() WHERE id=$3`, [
          transcript,
          JSON.stringify(analysis),
          id,
        ]);
        // Update company's lead score based on call analysis
        if (mapped.companyId) {
          await pool.query(`UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now() WHERE id=$3`, [
            analysis.score,
            JSON.stringify(analysis.reasons),
            mapped.companyId,
          ]);
          await pool.query(
            `INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`,
            [mapped.companyId, analysis.score, JSON.stringify(analysis.reasons), settings.icpDescription ?? '', 'call-analysis']
          );
          await logActivity({
            userId: String(mapped.calledBy),
            sessionId: null as unknown as string,
            eventType: 'company.scored_from_call',
            entityType: 'company',
            entityId: mapped.companyId,
            summary: `Call analysed — score ${analysis.score} (${analysis.tier}): ${analysis.summary.slice(0, 80)}`,
            payload: { score: analysis.score, tier: analysis.tier, transcript: transcript.slice(0, 500) },
          });
        }
      } catch (e) {
        console.warn('call transcription/analysis failed', e);
      }
    });
  });

  app.post('/api/conversations/:id/transcribe', requireAuth, async (req, res) => {
    const planCheckTranscribe = await getCurrentPlan();
    if (!hasFeature(planCheckTranscribe, 'call_analysis')) {
      res.status(402).json({ error: 'Transcription and call analysis require Pro plan. Upgrade in Subscription.', code: 'SUBSCRIPTION_REQUIRED', plan: planCheckTranscribe, requiredPlan: 'pro', feature: 'call_analysis' });
      return;
    }
    const { id } = req.params;
    const { audioBase64, mimeType } = req.body as { audioBase64?: string; mimeType?: string };
    const { rows } = await pool.query('SELECT * FROM conversations WHERE id=$1', [id]);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    // Detect seed/demo recordings which have no real audio data
    const isSeedRecording = row.s3_url && String(row.s3_url).startsWith('seed://');
    if (isSeedRecording && !audioBase64) {
      res.status(400).json({
        error: 'This is a seed demo recording with no audio data. Please upload a real call recording — tap Record on phone or choose an audio file — to transcribe and analyse.',
      });
      return;
    }

    let transcript = '';
    if (audioBase64) {
      transcript = await transcribeAudioBase64(audioBase64, mimeType ?? `audio/${row.file_ext}`);
    } else {
      // No base64 supplied — try S3 fetch (phone capture via S3 presign path)
      try {
        if (row.s3_url && !String(row.s3_url).startsWith('seed://')) {
          const key = keyFromUrl(row.s3_url as string);
          const buf = await getObjectBuffer(key);
          transcript = await transcribeAudioBase64(buf.toString('base64'), mimeType ?? `audio/${row.file_ext}`);
        } else if (row.s3_url && String(row.s3_url).startsWith('seed://')) {
          // Seed recordings have no audio — fail fast with helpful message
          transcript = '';
        } else {
          const staging = stagingKey(String(row.id), row.file_ext as string);
          const buf = await getObjectBuffer(staging);
          transcript = await transcribeAudioBase64(buf.toString('base64'), mimeType ?? `audio/${row.file_ext}`);
        }
      } catch {}
      if (!transcript && row.transcript) transcript = String(row.transcript);
    }
    if (!transcript) {
      if (isSeedRecording) {
        res.status(400).json({
          error: 'This is a seed demo recording with no audio data. Please upload a real call recording to transcribe and analyse. The transcription will also update the lead score based on your ICP.',
        });
        return;
      }
      res.status(400).json({ error: 'No audio data found for transcription. Please upload an audio file or record on your phone.' });
      return;
    }
    const settings = await getAppSettings();
    const { rows: fullRows } = await pool.query(`${CONVERSATION_SELECT} WHERE cv.id=$1`, [id]);
    const mapped = fullRows[0] ? mapConversation(fullRows[0]) : null;
    const analysis = await analyseTranscriptForLead(transcript, settings.icpDescription ?? '', {
      companyName: mapped?.companyName ?? '',
      contactName: mapped?.contactName ?? '',
      industry: '',
      stage: mapped?.stageAtCall ?? '',
    });
    await pool.query(`UPDATE conversations SET transcript=$1, analysis=$2::jsonb, updated_at=now() WHERE id=$3`, [
      transcript,
      JSON.stringify(analysis),
      id,
    ]);
    if (mapped?.companyId) {
      await pool.query(`UPDATE companies SET lead_score=$1, lead_score_reasons=$2::jsonb, lead_scored_at=now() WHERE id=$3`, [
        analysis.score,
        JSON.stringify(analysis.reasons),
        mapped.companyId,
      ]);
      await pool.query(`INSERT INTO lead_scores (company_id, score, reasons, icp_snapshot, model) VALUES ($1,$2,$3::jsonb,$4,$5)`, [
        mapped.companyId,
        analysis.score,
        JSON.stringify(analysis.reasons),
        settings.icpDescription ?? '',
        'call-transcribe-direct',
      ]);
    }
    const { rows: updated } = await pool.query(`${CONVERSATION_SELECT} WHERE cv.id=$1`, [id]);
    res.json(mapConversation(updated[0]));
  });

  app.get('/api/conversations', requireAuth, async (req, res) => {
    const contactId = req.query.contactId ? String(req.query.contactId) : null;
    const companyId = req.query.companyId ? String(req.query.companyId) : null;
    const conditions = ["cv.upload_status = 'completed'"];
    const values: string[] = [];
    if (contactId) {
      values.push(contactId);
      conditions.push(`cv.contact_id = $${values.length}`);
    }
    if (companyId) {
      values.push(companyId);
      conditions.push(`cv.company_id = $${values.length}`);
    }
    const { rows } = await pool.query(
      `${CONVERSATION_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY cv.called_at DESC`,
      values
    );
    res.json(rows.map(mapConversation));
  });

  app.get('/api/conversations/:id/play', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT s3_url FROM conversations WHERE id = $1 AND upload_status = 'completed'`,
      [id]
    );
    if (!rows[0]?.s3_url) {
      res.status(404).json({ error: 'Recording not found' });
      return;
    }
    const key = keyFromUrl(rows[0].s3_url);
    const playUrl = await presignGet(key);
    res.json({ playUrl });
  });

  app.delete('/api/conversations/:id', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { rows } = await pool.query(
      `
      SELECT cv.s3_url, cv.file_ext, cv.upload_status, t.contact_name
      FROM conversations cv
      LEFT JOIN contacts t ON t.id = cv.contact_id
      WHERE cv.id = $1
      `,
      [id]
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const contactName = row.contact_name ? String(row.contact_name) : 'contact';
    if (row.upload_status === 'completed' && row.s3_url) {
      try {
        await deleteObject(keyFromUrl(row.s3_url));
      } catch {
        /* object may already be gone */
      }
    } else if (row.upload_status === 'pending') {
      const staging = stagingKey(String(id), row.file_ext);
      await deleteObject(staging).catch(() => {});
    }
    await pool.query('DELETE FROM conversations WHERE id = $1', [id]);
    await logActivity({
      userId: req.user!.sub,
      sessionId: req.user!.sid,
      eventType: 'conversation.deleted',
      entityType: 'conversation',
      entityId: String(id),
      summary: `Deleted recording for ${contactName}`,
      payload: { name: contactName },
    });
    res.status(204).end();
  });
}
