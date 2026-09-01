import { useMemo, useState, type ChangeEvent, type FormEvent, useRef, useEffect } from 'react';
import ExcelJS from 'exceljs';
import type { CrmStore } from '../hooks/useCrmStore';
import type { ProspectRow } from '../types';
import {
  PROSPECT_TEMPLATE_CSV,
  parseProspectAuto,
  parseProspectMatrix,
  parseProspectPaste,
  previewByCompany,
} from '../lib/importProspects';
import { Field, btnPrimary, btnGhost, inputClass } from './ui';
import { useAppConfig } from '../hooks/useAppConfig';
import { useSubscription } from '../hooks/useSubscription';
import { scoreProspect, scoreColor, scoreLabel } from '../lib/leadScoring';
import { api } from '../lib/api';

interface ImportLeadsProps {
  store: CrmStore;
}

const EXAMPLE = `Company\tProspect Name\tJob Title\tEmail\tPhone\tLocation\tEmployees\tIndustry
Acme Bio Labs\tAlex Example\tHead of Operations\talex@acme-bio.example\t+1 555 010 1001\tAustin, USA\t180\tResearchBiotechnology
Northwind Health\tJordan Sample\tCo-Founder & CEO\tjordan@northwind-health.example\t+1 555 010 1002\tChicago, USA\t230\tHospital & Health Care`;

type Mode = 'single' | 'bulk' | 'voice' | 'image';

type ImportResult = {
  message: string;
  ok: boolean;
};

const emptySingle = {
  company: '',
  prospectName: '',
  jobTitle: '',
  email: '',
  phone: '',
  location: '',
  employees: '',
  industry: '',
};

function formatResult(result: {
  companiesCreated: number;
  companiesUpdated: number;
  contactsCreated: number;
  contactsSkipped: number;
}) {
  return `Done. ${result.companiesCreated} new companies, ${result.companiesUpdated} existing companies updated, ${result.contactsCreated} contacts added, ${result.contactsSkipped} duplicates skipped.`;
}

export function ImportLeads({ store }: ImportLeadsProps) {
  const { config } = useAppConfig();
  const sub = useSubscription();
  const [mode, setMode] = useState<Mode>('bulk');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileRows, setFileRows] = useState<ProspectRow[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [single, setSingle] = useState(emptySingle);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Voice state — reuses prospect parsing with auto-transcription
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceRows, setVoiceRows] = useState<ProspectRow[]>([]);
  const [voiceErrors, setVoiceErrors] = useState<string[]>([]);
  const [voiceFileName, setVoiceFileName] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimerRef = useRef<number | null>(null);

  // Image state — reuses same row pipeline, image+voice combined (non-binary)
  const [imageFileName, setImageFileName] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string | null>(null);
  const [imageRows, setImageRows] = useState<ProspectRow[]>([]);
  const [imageErrors, setImageErrors] = useState<string[]>([]);
  const [imageTextFallback, setImageTextFallback] = useState('');
  const [imageVoiceTranscript, setImageVoiceTranscript] = useState('');
  const [imageVoiceFileName, setImageVoiceFileName] = useState<string | null>(null);

  const pasted = useMemo(() => {
    if (!text.trim()) return { rows: [] as ProspectRow[], errors: [] as string[] };
    return parseProspectAuto(text);
  }, [text]);

  const bulkRows = fileRows.length > 0 ? fileRows : pasted.rows;
  const bulkErrors = fileRows.length > 0 ? fileErrors : pasted.errors;
  const byCompany = useMemo(() => previewByCompany(bulkRows), [bulkRows]);

  // Scoring helpers reused for all modes
  const icp = config.icpDescription ?? '';
  const scoredBulk = useMemo(() => bulkRows.map((r) => ({ row: r, score: scoreProspect(r, icp) })), [bulkRows, icp]);
  const scoredVoice = useMemo(() => voiceRows.map((r) => ({ row: r, score: scoreProspect(r, icp) })), [voiceRows, icp]);
  const scoredImage = useMemo(() => imageRows.map((r) => ({ row: r, score: scoreProspect(r, icp) })), [imageRows, icp]);

  const cleanErrors = (errs: string[]) => errs.map((e) => (e.includes('too few columns') ? 'Could not extract — please provide Company and Prospect Name.' : e));

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  const runBulkImport = async () => {
    if (bulkRows.length === 0) {
      setLastResult({
        message: 'Nothing to import — paste rows or upload a file first.',
        ok: false,
      });
      return;
    }
    setBusy(true);
    try {
      const result = await store.importProspects(bulkRows);
      setLastResult({ message: formatResult(result), ok: true });
      setText('');
      setFileName(null);
      setFileRows([]);
      setFileErrors([]);
    } catch (e) {
      setLastResult({
        message: e instanceof Error ? e.message : 'Import failed',
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const runSingleImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!single.company.trim() || !single.prospectName.trim()) return;
    setBusy(true);
    setLastResult(null);
    try {
      const row: ProspectRow = {
        company: single.company.trim(),
        prospectName: single.prospectName.trim(),
        jobTitle: single.jobTitle.trim(),
        email: single.email.trim().toLowerCase(),
        phone: single.phone.trim(),
        location: single.location.trim(),
        employees: single.employees
          ? Number(single.employees.replace(/[^0-9]/g, '')) || null
          : null,
        industry: single.industry.trim(),
      };
      const result = await store.importProspects([row]);
      setLastResult({ message: formatResult(result), ok: true });
      setSingle(emptySingle);
    } catch (err) {
      setLastResult({
        message: err instanceof Error ? err.message : 'Import failed',
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLastResult(null);
    setText('');
    try {
      const buf = await file.arrayBuffer();
      const name = file.name.toLowerCase();

      // Excel
      if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const sheet = wb.worksheets[0];
        if (!sheet) {
          setFileRows([]);
          setFileErrors(['No sheet found in file.']);
          setFileName(file.name);
          return;
        }
        const matrix: unknown[][] = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const values = row.values;
          const cells = Array.isArray(values) ? values.slice(1).map((v) => (v == null ? '' : String(v))) : [];
          matrix.push(cells);
        });
        const parsed = parseProspectMatrix(matrix);
        setFileRows(parsed.rows);
        setFileErrors(parsed.errors);
        setFileName(file.name);
        return;
      }

      // Text-based: csv, txt, html, xml, json, md — auto-detect via parseProspectAuto
      const text = new TextDecoder('utf-8').decode(buf);
      // Quick check if it's JSON/HTML/XML/MD by content or extension
      const lowerText = text.trim().toLowerCase();
      const isJson = name.endsWith('.json') || (lowerText.startsWith('{') || lowerText.startsWith('['));
      const isHtml = name.endsWith('.html') || name.endsWith('.htm') || lowerText.includes('<table') || lowerText.includes('<html');
      const isXml = name.endsWith('.xml') || lowerText.startsWith('<?xml') || lowerText.startsWith('<rows') || lowerText.startsWith('<leads');
      const isMd = name.endsWith('.md') || (text.includes('|') && text.includes('---'));

      if (isJson || isHtml || isXml || isMd || name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.html') || name.endsWith('.xml') || name.endsWith('.json')) {
        const parsed = parseProspectAuto(text, file.name);
        setFileRows(parsed.rows);
        setFileErrors(parsed.errors);
        setFileName(file.name);
        return;
      }

      // Fallback: try as text with auto delimiter
      const parsed = parseProspectAuto(text, file.name);
      setFileRows(parsed.rows);
      setFileErrors(parsed.errors);
      setFileName(file.name);
    } catch {
      setFileRows([]);
      setFileErrors(['Could not read file. Supported: csv, excel, txt, html, xml, json, md.']);
      setFileName(file.name);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([PROSPECT_TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leads-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const resultBannerClass = (ok: boolean) =>
    ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800';

  // Voice handlers — auto-transcription with field extraction
  const fileToBase64 = (file: File | Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = reader.result as string;
        const b64 = res.includes(',') ? res.split(',')[1] : res;
        resolve(b64 ?? '');
      };
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file as Blob);
    });

  const onVoiceFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setVoiceFileName(file.name);
    setLastResult(null);
    setVoiceErrors([]);
    const lowerName = file.name.toLowerCase();
    const isTextLike =
      lowerName.endsWith('.txt') ||
      lowerName.endsWith('.csv') ||
      lowerName.endsWith('.json') ||
      lowerName.endsWith('.html') ||
      lowerName.endsWith('.htm') ||
      lowerName.endsWith('.xml') ||
      lowerName.endsWith('.md') ||
      file.type.startsWith('text') ||
      file.type.includes('json') ||
      file.type.includes('html') ||
      file.type.includes('xml');
    if (isTextLike) {
      const t = (await file.text()).trimStart().trim();
      setVoiceTranscript(t);
      const parsed = parseProspectAuto(t, file.name);
      setVoiceRows(parsed.rows);
      setVoiceErrors(cleanErrors(parsed.errors));
      if (parsed.rows.length === 0 && t.length > 0) {
        // Try AI extraction for free-form transcript files (txt/json/html/md)
        try {
          const out = await api<{ rows: ProspectRow[]; errors: string[]; transcript?: string }>('/api/import/voice/extract', {
            method: 'POST',
            body: JSON.stringify({ transcript: t }),
          });
          if (out.rows?.length) {
            setVoiceRows(out.rows);
            setVoiceErrors(cleanErrors(out.errors ?? []));
            if (out.transcript) setVoiceTranscript(out.transcript);
          }
        } catch {}
      }
      return;
    }
    // Audio types: mp3, wav, m4a, webm, ogg, flac, aac, wma, mp4, 3gp, etc — handle via audio/* plus video with audio
    setVoiceBusy(true);
    setVoiceErrors(['Transcribing…']);
    try {
      const b64 = await fileToBase64(file);
      const out = await api<{ rows: ProspectRow[]; errors: string[]; transcript?: string }>('/api/import/voice/extract', {
        method: 'POST',
        body: JSON.stringify({ audioBase64: b64 }),
      });
      if (out.transcript) setVoiceTranscript(out.transcript);
      setVoiceRows(out.rows ?? []);
      setVoiceErrors(out.errors ?? []);
      if (!out.rows?.length && !out.errors?.length) {
        setVoiceErrors(['Transcribed but no leads extracted. Edit transcript and click Extract with AI (strict).']);
      }
    } catch (err) {
      setVoiceTranscript('');
      setVoiceRows([]);
      setVoiceErrors([err instanceof Error ? err.message : 'Transcription failed — please add transcript manually.']);
    } finally {
      setVoiceBusy(false);
    }
  };

  const runVoiceExtract = async () => {
    const cleanedTranscript = voiceTranscript.trimStart().trim();
    if (!cleanedTranscript) {
      setVoiceErrors(['Add transcript or upload audio first.']);
      return;
    }
    if (cleanedTranscript !== voiceTranscript) setVoiceTranscript(cleanedTranscript);
    setVoiceBusy(true);
    setVoiceErrors([]);
    try {
      const out = await api<{ rows: ProspectRow[]; errors: string[]; transcript?: string }>('/api/import/voice/extract', {
        method: 'POST',
        body: JSON.stringify({ transcript: cleanedTranscript }),
      });
      if (out.transcript) {
        const t = out.transcript.trimStart().trim();
        if (t !== voiceTranscript) setVoiceTranscript(t);
      }
      if (out.rows?.length) {
        setVoiceRows(out.rows);
        setVoiceErrors(cleanErrors(out.errors ?? []));
        return;
      }
      const parsed = parseProspectPaste(cleanedTranscript);
      setVoiceRows(parsed.rows);
      setVoiceErrors(parsed.rows.length ? cleanErrors(parsed.errors) : cleanErrors(out.errors ?? ['Could not extract. Please include Company and Prospect Name.']));
    } catch {
      const parsed = parseProspectPaste(cleanedTranscript);
      setVoiceRows(parsed.rows);
      setVoiceErrors(parsed.rows.length ? cleanErrors(parsed.errors) : ['Service unavailable — please try again.']);
    } finally {
      setVoiceBusy(false);
    }
  };

  const runVoiceImport = async () => {
    if (voiceRows.length === 0) {
      setLastResult({ message: 'No voice leads to import — extract first.', ok: false });
      return;
    }
    setBusy(true);
    try {
      const result = await store.importProspects(voiceRows);
      setLastResult({ message: `Voice: ${formatResult(result)}`, ok: true });
      setVoiceTranscript('');
      setVoiceRows([]);
      setVoiceErrors([]);
      setVoiceFileName(null);
    } catch (err) {
      setLastResult({ message: err instanceof Error ? err.message : 'Import failed', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined });
      const chunks: BlobPart[] = [];
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        const name = `recording-${Date.now()}.webm (${Math.round(blob.size / 1024)}KB)`;
        setVoiceFileName(name);
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        setIsRecording(false);
        setVoiceBusy(true);
        setVoiceErrors(['Transcribing recording…']);
        try {
          const b64 = await fileToBase64(blob);
          const out = await api<{ rows: ProspectRow[]; errors: string[]; transcript?: string }>('/api/import/voice/extract', {
            method: 'POST',
            body: JSON.stringify({ audioBase64: b64 }),
          });
          if (out.transcript) setVoiceTranscript(out.transcript);
          setVoiceRows(out.rows ?? []);
          setVoiceErrors(out.errors ?? []);
          if (out.rows?.length) {
            setVoiceErrors([]);
          } else if (!out.errors?.length) {
            setVoiceErrors(['Transcribed. No leads found — please edit and try again.']);
          }
        } catch (err) {
          setVoiceErrors([err instanceof Error ? err.message : 'Transcription failed — please add transcript manually.']);
        } finally {
          setVoiceBusy(false);
        }
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setVoiceErrors(['Microphone not available. Upload an audio file or paste a transcript instead.']);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  // Image handlers — handles image/* (png,jpg,webp,heic,gif,bmp,tiff,svg,pdf) + text-like fallbacks (html/xml/json/md/csv/txt)
  const onImageFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImageFileName(file.name);
    setImageMimeType(file.type || 'image/jpeg');
    setLastResult(null);
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    const url = URL.createObjectURL(file);
    setImagePreviewUrl(url);
    const lowerName = file.name.toLowerCase();
    const isTextLike =
      lowerName.endsWith('.txt') ||
      lowerName.endsWith('.csv') ||
      lowerName.endsWith('.json') ||
      lowerName.endsWith('.html') ||
      lowerName.endsWith('.htm') ||
      lowerName.endsWith('.xml') ||
      lowerName.endsWith('.md') ||
      file.type.startsWith('text') ||
      file.type.includes('json') ||
      file.type.includes('html') ||
      file.type.includes('xml');
    try {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      if (!isTextLike) {
        setImageBase64(b64);
      } else {
        setImageBase64(null);
      }
    } catch {
      setImageBase64(null);
    }
    if (isTextLike) {
      const t = await file.text();
      setImageTextFallback(t);
      const parsed = parseProspectAuto(t, file.name);
      setImageRows(parsed.rows);
      setImageErrors(cleanErrors(parsed.errors));
      if (parsed.rows.length === 0 && t.trim().length > 0) {
        try {
          const out = await api<{ rows: ProspectRow[]; errors: string[]; text?: string }>('/api/import/image/extract', {
            method: 'POST',
            body: JSON.stringify({ fallbackText: t }),
          });
          if (out.rows?.length) {
            setImageRows(out.rows);
            setImageErrors(cleanErrors(out.errors ?? []));
          }
        } catch {}
      }
    } else {
      setImageRows([]);
      setImageErrors(['Image received. Please add details below, then click Extract.']);
    }
  };

  const onImageVoiceFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImageVoiceFileName(file.name);
    if (file.name.toLowerCase().endsWith('.txt') || file.name.toLowerCase().endsWith('.csv') || file.type.startsWith('text')) {
      const t = await file.text();
      setImageVoiceTranscript(t);
    } else {
      setImageVoiceTranscript('');
      setImageErrors(['Voice received. Please add transcript below.']);
    }
  };

  const runImageExtract = async () => {
    const hasImage = !!imageBase64;
    const hasVoice = !!imageVoiceTranscript.trimStart().trim();
    const cleanedFallback = imageTextFallback.trimStart().trim();
    const cleanedVoice = imageVoiceTranscript.trimStart().trim();
    if (cleanedFallback !== imageTextFallback) setImageTextFallback(cleanedFallback);
    if (cleanedVoice !== imageVoiceTranscript) setImageVoiceTranscript(cleanedVoice);
    if ((hasImage || hasVoice) && imageBase64) {
      try {
        const out = await api<{ rows: ProspectRow[]; errors: string[]; text?: string; transcript?: string }>('/api/import/image/extract', {
          method: 'POST',
          body: JSON.stringify({
            imageBase64,
            mimeType: imageMimeType ?? 'image/jpeg',
            transcript: cleanedVoice || undefined,
            fallbackText: cleanedFallback || undefined,
          }),
        });
        if (out.rows?.length) {
          setImageRows(out.rows);
          setImageErrors(out.errors ?? []);
          return;
        }
        if (out.errors?.length) {
          // Fallback to local parse of combined text if AI returns no rows but no hard error
          const combined = [imageVoiceTranscript, imageTextFallback].filter(Boolean).join('\n');
          if (combined.trim()) {
            const parsed = parseProspectPaste(combined);
            if (parsed.rows.length) {
              setImageRows(parsed.rows);
              setImageErrors(parsed.errors);
              return;
            }
          }
          setImageRows([]);
          setImageErrors(cleanErrors(out.errors));
          return;
        }
      } catch {
        // fall through
      }
    }
    const combinedFallback = [imageVoiceTranscript.trimStart().trim(), imageTextFallback.trimStart().trim()].filter(Boolean).join('\n');
    const toParse = combinedFallback || imageTextFallback.trimStart().trim();
    const parsed = parseProspectPaste(toParse);
    if (parsed.rows.length) {
      setImageRows(parsed.rows);
      setImageErrors(cleanErrors(parsed.errors));
    } else {
      setImageRows([]);
      setImageErrors(cleanErrors(parsed.errors).length ? cleanErrors(parsed.errors) : ['Could not extract — please provide Company and Prospect Name.']);
    }
  };

  const runImageImport = async () => {
    if (imageRows.length === 0) {
      setLastResult({ message: 'No image leads to import — extract first.', ok: false });
      return;
    }
    setBusy(true);
    try {
      const result = await store.importProspects(imageRows);
      setLastResult({ message: `Image: ${formatResult(result)}`, ok: true });
      setImageRows([]);
      setImageErrors([]);
      setImageFileName(null);
      setImageTextFallback('');
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl);
        setImagePreviewUrl(null);
      }
    } catch (err) {
      setLastResult({ message: err instanceof Error ? err.message : 'Import failed', ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-xs font-semibold tracking-[0.14em] text-teal-700 uppercase">
          Morning import
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl text-stone-900 sm:text-4xl">
          Import leads
        </h1>
        <p className="mt-2 text-sm text-stone-500">
          Add one lead or import many. Columns:{' '}
          <span className="font-medium text-stone-700">
            Company, Prospect Name, Job Title, Email, Phone, Location, Employees, Industry
          </span>
          . Existing companies are matched by name; duplicate emails are skipped. Voice & image use AI extraction against your ICP.
        </p>
        {icp ? (
          <p className="mt-2 rounded-none bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Scoring against ICP: <span className="font-medium">{icp.slice(0, 120)}{icp.length > 120 ? '…' : ''}</span>{' '}
            <span className="text-stone-500">(edit in Settings → ICP)</span>
          </p>
        ) : (
          <p className="mt-2 text-xs text-stone-400">
            No ICP configured — scores will be neutral. Set ICP in Settings for AI scoring.
          </p>
        )}
      </header>

      <div className="flex flex-wrap gap-1 rounded-none border border-[var(--color-line)] bg-stone-50 p-1">
        {(['single', 'bulk', 'voice', 'image'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-none px-3 py-2 text-sm font-medium capitalize transition ${
              mode === m ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'
            }`}
            onClick={() => setMode(m)}
            data-testid={`import-tab-${m}`}
          >
            <span>{m === 'single' ? 'Single lead' : m === 'bulk' ? 'Bulk import' : m === 'voice' ? 'Voice' : 'Image / Card'}</span>
            {m === 'voice' && !sub.hasVoice ? (
              <span className="rounded bg-amber-100 px-1 py-0.2 text-[10px] font-bold text-amber-800">
                PRO
              </span>
            ) : null}
            {m === 'image' && !sub.hasImage ? (
              <span className="rounded bg-amber-100 px-1 py-0.2 text-[10px] font-bold text-amber-800">
                PRO
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {mode === 'single' ? (
        <form
          onSubmit={runSingleImport}
          className="space-y-4 rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company *" className="sm:col-span-2">
              <input
                className={inputClass}
                value={single.company}
                onChange={(e) => setSingle((s) => ({ ...s, company: e.target.value }))}
                required
              />
            </Field>
            <Field label="Prospect name *">
              <input
                className={inputClass}
                value={single.prospectName}
                onChange={(e) => setSingle((s) => ({ ...s, prospectName: e.target.value }))}
                required
              />
            </Field>
            <Field label="Job title">
              <input
                className={inputClass}
                value={single.jobTitle}
                onChange={(e) => setSingle((s) => ({ ...s, jobTitle: e.target.value }))}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                className={inputClass}
                value={single.email}
                onChange={(e) => setSingle((s) => ({ ...s, email: e.target.value }))}
              />
            </Field>
            <Field label="Phone">
              <input
                className={inputClass}
                value={single.phone}
                onChange={(e) => setSingle((s) => ({ ...s, phone: e.target.value }))}
              />
            </Field>
            <Field label="Location">
              <input
                className={inputClass}
                value={single.location}
                onChange={(e) => setSingle((s) => ({ ...s, location: e.target.value }))}
              />
            </Field>
            <Field label="Employees">
              <input
                className={inputClass}
                inputMode="numeric"
                value={single.employees}
                onChange={(e) => setSingle((s) => ({ ...s, employees: e.target.value }))}
              />
            </Field>
            <Field label="Industry" className="sm:col-span-2">
              <input
                className={inputClass}
                value={single.industry}
                onChange={(e) => setSingle((s) => ({ ...s, industry: e.target.value }))}
                placeholder="Healthcare, SaaS, …"
              />
            </Field>
          </div>
          {single.company && single.prospectName ? (
            <div className="rounded-none bg-stone-50 px-3 py-2 text-xs">
              AI score preview:{' '}
              <span className={`rounded-none px-2 py-0.5 text-xs font-medium ${scoreColor(scoreProspect({ company: single.company, prospectName: single.prospectName, jobTitle: single.jobTitle, email: single.email.toLowerCase(), phone: single.phone, location: single.location, employees: single.employees ? Number(single.employees.replace(/[^0-9]/g, '')) || null : null, industry: single.industry }, icp).score)}`}>
                {scoreLabel(scoreProspect({ company: single.company, prospectName: single.prospectName, jobTitle: single.jobTitle, email: single.email.toLowerCase(), phone: single.phone, location: single.location, employees: single.employees ? Number(single.employees.replace(/[^0-9]/g, '')) || null : null, industry: single.industry }, icp).score)}
              </span>
              <span className="ml-2 text-stone-500">{scoreProspect({ company: single.company, prospectName: single.prospectName, jobTitle: single.jobTitle, email: single.email.toLowerCase(), phone: single.phone, location: single.location, employees: single.employees ? Number(single.employees.replace(/[^0-9]/g, '')) || null : null, industry: single.industry }, icp).reasons.join(' · ')}</span>
            </div>
          ) : null}
          <button type="submit" className={btnPrimary} disabled={busy}>
            {busy ? 'Saving…' : 'Add lead'}
          </button>
          {lastResult && mode === 'single' ? (
            <p className={`rounded-none px-3 py-2 text-sm ${resultBannerClass(lastResult.ok)}`}>
              {lastResult.message}
            </p>
          ) : null}
        </form>
      ) : null}

      {mode === 'bulk' ? (
        <>
          <div className="rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
            <div className="flex flex-wrap items-center gap-2">
              <label className={`${btnGhost} cursor-pointer`}>
                Upload file
                <input
                  type="file"
                  accept=".csv,.tsv,.txt,.html,.htm,.xml,.json,.md,.xlsx,.xls,text/csv,text/tab-separated-values,text/plain,text/html,application/xml,application/json,text/markdown,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  className="hidden"
                  onChange={onFile}
                />
              </label>
              <button type="button" className={btnGhost} onClick={downloadTemplate}>
                Download template
              </button>
              {fileName ? (
                <span className="text-xs text-stone-500">
                  Loaded: {fileName} ({fileRows.length} rows)
                </span>
              ) : null}
            </div>

            <label className="mt-4 block text-sm font-medium text-stone-600">
              Or paste table here
            </label>
            <textarea
              className={`${inputClass} mt-2 min-h-[220px] font-mono text-xs leading-relaxed`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(null);
                setFileRows([]);
                setFileErrors([]);
                setLastResult(null);
              }}
              placeholder={EXAMPLE}
              spellCheck={false}
            />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={btnPrimary}
                onClick={() => void runBulkImport()}
                disabled={busy}
              >
                {busy
                  ? 'Importing…'
                  : `Import ${bulkRows.length > 0 ? `${bulkRows.length} rows` : ''}`}
              </button>
              <button
                type="button"
                className={btnGhost}
                onClick={() => {
                  setText('');
                  setFileName(null);
                  setFileRows([]);
                  setFileErrors([]);
                  setLastResult(null);
                }}
              >
                Clear
              </button>
              <button
                type="button"
                className={btnGhost}
                onClick={() => {
                  setText(EXAMPLE);
                  setFileName(null);
                  setFileRows([]);
                  setFileErrors([]);
                  setLastResult(null);
                }}
              >
                Load example format
              </button>
            </div>

            {bulkErrors.length > 0 ? (
              <ul className="mt-3 space-y-1 rounded-none bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {bulkErrors.slice(0, 8).map((err) => (
                  <li key={err}>{err}</li>
                ))}
                {bulkErrors.length > 8 ? <li>+{bulkErrors.length - 8} more…</li> : null}
              </ul>
            ) : null}

            {lastResult && mode === 'bulk' ? (
              <p
                className={`mt-3 rounded-none px-3 py-2 text-sm ${resultBannerClass(lastResult.ok)}`}
              >
                {lastResult.message}
              </p>
            ) : null}
          </div>

          {byCompany.length > 0 ? (
            <div className="rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
              <h2 className="text-sm font-semibold text-stone-800">Preview by company</h2>
              <ul className="mt-3 divide-y divide-[var(--color-line)]">
                {byCompany.map((c) => (
                  <li key={c.company} className="flex items-center justify-between py-2 text-sm">
                    <span className="font-medium text-stone-800">{c.company}</span>
                    <span className="text-stone-500">{c.count} contacts</span>
                  </li>
                ))}
              </ul>
              {scoredBulk.length ? (
                <div className="mt-4 space-y-2">
                  <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">AI scores (ICP)</h3>
                  {scoredBulk.slice(0, 8).map(({ row, score }, i) => (
                    <div key={`${row.company}-${i}`} className="flex items-center justify-between text-xs">
                      <span className="truncate pr-2">{row.company} — {row.prospectName}</span>
                      <span className={`rounded-none px-2 py-0.5 font-medium ${scoreColor(score.score)}`}>{scoreLabel(score.score)}</span>
                    </div>
                  ))}
                  {scoredBulk.length > 8 ? <p className="text-xs text-stone-400">+{scoredBulk.length - 8} more</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {mode === 'voice' ? (
        <div className="space-y-4 rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          {!sub.hasVoice ? (
            <div className="rounded-none border border-amber-300 bg-amber-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-amber-950 uppercase tracking-wider">Voice AI · Pro Feature</p>
                  <p className="mt-0.5 text-xs text-amber-800">
                    Audio recording, auto-transcription via Whisper, and voice lead extraction are available on Pro and Enterprise tiers.
                  </p>
                </div>
                <a
                  href="/?page=subscription"
                  className={`${btnPrimary} text-xs py-1.5 px-3 bg-amber-800 hover:bg-amber-900 text-white`}
                >
                  View Plans & Upgrade
                </a>
              </div>
            </div>
          ) : null}
          <Field label="Voice lead — upload or record">
            <div className="flex flex-wrap items-center gap-2">
              <label className={`${btnGhost} cursor-pointer`}>
                Upload audio / transcript
                <input
                  type="file"
                  accept="audio/*,video/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.aac,.wma,.mp4,.3gp,.txt,.csv,.tsv,.html,.htm,.xml,.json,.md"
                  className="hidden"
                  onChange={onVoiceFile}
                />
              </label>
              {!isRecording ? (
                <button type="button" className={btnGhost} onClick={() => void startRecording()}>
                  Record
                </button>
              ) : (
                <button type="button" className={btnPrimary} onClick={stopRecording}>
                  Stop ({recordSeconds}s)
                </button>
              )}
              {voiceFileName ? <span className="text-xs text-stone-500">{voiceFileName}</span> : null}
            </div>
          </Field>
          <Field label="Transcript / spoken details — bulk CSV or natural voice">
            <textarea
              className={`${inputClass} min-h-28 font-mono text-xs`}
              value={voiceTranscript}
              onChange={(e) => setVoiceTranscript(e.target.value)}
              placeholder="Speak naturally, record a voice note, or paste lead data (e.g. Met with Alex Smith, VP of Operations at Acme Corp, email alex@acme.example, interested in a demo)&#10;Or paste CSV/TSV data"
              rows={4}
            />
            <p className="mt-1 text-xs text-stone-500">Speak naturally, record a voice note, or paste lead data to automatically extract company, prospect, and contact details.</p>
          </Field>
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} onClick={() => void runVoiceExtract()} disabled={!voiceTranscript.trim() || voiceBusy}>
              {voiceBusy ? 'Extracting…' : 'Extract with AI'}
            </button>
            <button type="button" className={btnGhost} onClick={() => { setVoiceTranscript(''); setVoiceRows([]); setVoiceErrors([]); setVoiceFileName(null); }}>
              Clear
            </button>
          </div>
          {voiceBusy ? <p className="text-xs text-stone-500">Processing…</p> : null}
          {voiceErrors.length ? (
            <ul className="space-y-1 rounded-none bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {voiceErrors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          ) : null}
          {scoredVoice.length ? (
            <div className="rounded-none border border-[var(--color-line)] bg-white p-3">
              <h3 className="text-sm font-semibold text-stone-800">Voice preview — {scoredVoice.length} leads (scored)</h3>
              <ul className="mt-2 divide-y divide-[var(--color-line)]">
                {scoredVoice.map(({ row, score }, i) => (
                  <li key={`${row.company}-${i}`} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium text-stone-800">{row.company} — {row.prospectName}</p>
                      <p className="truncate text-xs text-stone-500">{row.jobTitle} · {row.email} · {row.industry}</p>
                      <p className="text-[11px] text-stone-400">{score.reasons.join(' · ')}</p>
                    </div>
                    <span className={`shrink-0 rounded-none px-2 py-1 text-xs font-medium ${scoreColor(score.score)}`}>{scoreLabel(score.score)}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className={`${btnPrimary} mt-3`} onClick={() => void runVoiceImport()} disabled={busy}>
                {busy ? 'Importing…' : `Import ${scoredVoice.length} voice leads`}
              </button>
            </div>
          ) : null}
          {lastResult && mode === 'voice' ? (
            <p className={`rounded-none px-3 py-2 text-sm ${resultBannerClass(lastResult.ok)}`}>{lastResult.message}</p>
          ) : null}
        </div>
      ) : null}

      {mode === 'image' ? (
        <div className="space-y-4 rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          {!sub.hasImage ? (
            <div className="rounded-none border border-amber-300 bg-amber-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-amber-950 uppercase tracking-wider">Image AI · Pro Feature</p>
                  <p className="mt-0.5 text-xs text-amber-800">
                    Business card OCR with Vision AI and combined voice + image lead parsing are available on Pro and Enterprise tiers.
                  </p>
                </div>
                <a
                  href="/?page=subscription"
                  className={`${btnPrimary} text-xs py-1.5 px-3 bg-amber-800 hover:bg-amber-900 text-white`}
                >
                  View Plans & Upgrade
                </a>
              </div>
            </div>
          ) : null}
          <Field label="Business card — photo or card text (phone camera supported)">
            <div className="flex flex-wrap items-center gap-2">
              <label className={`${btnGhost} cursor-pointer`}>
                Upload image / card
                <input
                  type="file"
                  accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif,.gif,.bmp,.tiff,.svg,.pdf,.txt,.csv,.tsv,.html,.htm,.xml,.json,.md"
                  className="hidden"
                  onChange={onImageFile}
                />
              </label>
              <label className={`${btnGhost} cursor-pointer`}>
                Capture on phone
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={onImageFile}
                />
              </label>
              {imageFileName ? <span className="text-xs text-stone-500">{imageFileName}</span> : null}
            </div>
            {imagePreviewUrl ? (
              <img src={imagePreviewUrl} alt="card preview" className="mt-3 max-h-48 rounded-none border border-[var(--color-line)] object-contain" />
            ) : null}
            <p className="mt-2 text-xs text-stone-500">On phone, “Capture on phone” opens camera directly (back camera). Reuses same AI pipeline.</p>
          </Field>
          <Field label="Card text (paste OCR or type)">
            <textarea
              className={`${inputClass} min-h-28 font-mono text-xs`}
              value={imageTextFallback}
              onChange={(e) => setImageTextFallback(e.target.value)}
              placeholder="Paste card text or CSV row:&#10;Acme Corp, Alex Smith, Head of Operations, alex@acme.example, 555-0101, Austin, 180, SaaS"
              rows={4}
            />
            <p className="mt-1 text-xs text-stone-500">Text from image. Please ensure Company and Prospect Name are included.</p>
          </Field>
          <Field label="Optional voice — combine with image (non-binary)">
            <div className="flex flex-wrap items-center gap-2">
              <label className={`${btnGhost} cursor-pointer`}>
                Upload voice for card
                <input
                  type="file"
                  accept="audio/*,video/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.aac,.txt,.csv,.tsv,.html,.htm,.xml,.json,.md"
                  className="hidden"
                  onChange={onImageVoiceFile}
                />
              </label>
              {imageVoiceFileName ? <span className="text-xs text-stone-500">{imageVoiceFileName}</span> : null}
            </div>
            <textarea
              className={`${inputClass} mt-2 min-h-20 font-mono text-xs`}
              value={imageVoiceTranscript}
              onChange={(e) => setImageVoiceTranscript(e.target.value)}
              placeholder="Optional voice note to enrich card details: &quot;Met Alex from Acme Corp, 120 employees, SaaS, alex@acme.example&quot;"
              rows={3}
            />
            <p className="mt-1 text-xs text-stone-500">When voice is added, both image and transcript are combined.</p>
          </Field>
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} onClick={() => void runImageExtract()} disabled={!imageTextFallback.trim() && !imageVoiceTranscript.trim() && !imageBase64}>
              Extract with AI
            </button>
            <button type="button" className={btnGhost} onClick={() => { setImageTextFallback(''); setImageVoiceTranscript(''); setImageRows([]); setImageErrors([]); setImageFileName(null); setImageVoiceFileName(null); setImageBase64(null); if (imagePreviewUrl) { URL.revokeObjectURL(imagePreviewUrl); setImagePreviewUrl(null); } }}>
              Clear
            </button>
          </div>
          {imageErrors.length ? (
            <ul className="space-y-1 rounded-none bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {imageErrors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          ) : null}
          {scoredImage.length ? (
            <div className="rounded-none border border-[var(--color-line)] bg-white p-3">
              <h3 className="text-sm font-semibold text-stone-800">Card preview — {scoredImage.length} leads (scored)</h3>
              <ul className="mt-2 divide-y divide-[var(--color-line)]">
                {scoredImage.map(({ row, score }, i) => (
                  <li key={`${row.company}-${i}`} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium text-stone-800">{row.company} — {row.prospectName}</p>
                      <p className="truncate text-xs text-stone-500">{row.jobTitle} · {row.email} · {row.industry}</p>
                      <p className="text-[11px] text-stone-400">{score.reasons.join(' · ')}</p>
                    </div>
                    <span className={`shrink-0 rounded-none px-2 py-1 text-xs font-medium ${scoreColor(score.score)}`}>{scoreLabel(score.score)}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className={`${btnPrimary} mt-3`} onClick={() => void runImageImport()} disabled={busy}>
                {busy ? 'Importing…' : `Import ${scoredImage.length} card leads`}
              </button>
            </div>
          ) : null}
          {lastResult && mode === 'image' ? (
            <p className={`rounded-none px-3 py-2 text-sm ${resultBannerClass(lastResult.ok)}`}>{lastResult.message}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
