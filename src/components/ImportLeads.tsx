import { useState, useMemo, useRef, useEffect, type ChangeEvent, type FormEvent } from 'react';
import type { ImportResult, ProspectRow } from '../types';
import type { CrmStore } from '../hooks/useCrmStore';
import {
  parseProspectAuto,
  parseProspectPaste,
  previewByCompany,
} from '../lib/importProspects';
import { Field, inputClass, btnPrimary, btnGhost } from './ui';
import { useAppConfig } from '../hooks/useAppConfig';
import { useSubscription } from '../hooks/useSubscription';
import { scoreProspect, scoreColor, scoreLabel } from '../lib/leadScoring';
import { api } from '../lib/api';
import ExcelJS from 'exceljs';

interface ImportLeadsProps {
  store: CrmStore;
}

type Mode = 'single' | 'bulk' | 'voice' | 'image';

interface ManualLeadEntry {
  id: string;
  company: string;
  prospectName: string;
  jobTitle: string;
  email: string;
  phone: string;
  location: string;
  employees: string;
  industry: string;
  description: string;
}

const createBlankLead = (id?: string): ManualLeadEntry => ({
  id: id || Math.random().toString(36).substring(2, 9),
  company: '',
  prospectName: '',
  jobTitle: '',
  email: '',
  phone: '',
  location: '',
  employees: '',
  industry: '',
  description: '',
});

function formatResult(result: ImportResult): string {
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
  const [lastResult, setLastResult] = useState<{ message: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  // Multi-lead manual entry list state
  const [manualLeads, setManualLeads] = useState<ManualLeadEntry[]>([createBlankLead('1')]);

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

  const updateManualLead = (id: string, field: keyof ManualLeadEntry, value: string) => {
    setManualLeads((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  const addManualLead = () => {
    setManualLeads((prev) => [...prev, createBlankLead()]);
  };

  const removeManualLead = (id: string) => {
    setManualLeads((prev) => {
      if (prev.length <= 1) return [createBlankLead('1')];
      return prev.filter((item) => item.id !== id);
    });
  };

  const clearManualLeads = () => {
    setManualLeads([createBlankLead('1')]);
    setLastResult(null);
  };

  const runManualImport = async (e: FormEvent) => {
    e.preventDefault();
    const validRows: ProspectRow[] = manualLeads
      .filter((l) => l.company.trim() && l.prospectName.trim())
      .map((l) => ({
        company: l.company.trim(),
        prospectName: l.prospectName.trim(),
        jobTitle: l.jobTitle.trim(),
        email: l.email.trim().toLowerCase(),
        phone: l.phone.trim(),
        location: l.location.trim(),
        employees: l.employees ? Number(l.employees.replace(/[^0-9]/g, '')) || null : null,
        industry: l.industry.trim(),
        description: l.description.trim(),
      }));

    if (validRows.length === 0) {
      setLastResult({
        message: 'Please fill in at least Company and Prospect Name for at least one lead.',
        ok: false,
      });
      return;
    }

    setBusy(true);
    setLastResult(null);
    try {
      const result = await store.importProspects(validRows);
      setLastResult({
        message: `Imported ${validRows.length} lead${validRows.length > 1 ? 's' : ''}: ${formatResult(result)}`,
        ok: true,
      });
      setManualLeads([createBlankLead('1')]);
    } catch (err) {
      setLastResult({
        message: err instanceof Error ? err.message : 'Import failed',
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  };

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
        const ws = wb.worksheets[0];
        if (!ws) {
          setFileErrors(['Workbook has no sheets']);
          return;
        }
        const matrix: unknown[][] = [];
        ws.eachRow({ includeEmpty: false }, (r) => {
          const rowVals: unknown[] = [];
          r.eachCell({ includeEmpty: true }, (c) => {
            const v = c.value;
            if (v && typeof v === 'object') {
              if ('text' in v && typeof (v as { text: unknown }).text === 'string') {
                rowVals.push((v as { text: string }).text);
              } else if ('result' in v) {
                rowVals.push(String((v as { result: unknown }).result ?? ''));
              } else {
                rowVals.push(String(v));
              }
            } else {
              rowVals.push(v == null ? '' : String(v));
            }
          });
          if (rowVals.some((x) => String(x).trim().length > 0)) {
            matrix.push(rowVals);
          }
        });
        const { parseProspectMatrix } = await import('../lib/importProspects');
        const parsed = parseProspectMatrix(matrix);
        setFileName(file.name);
        setFileRows(parsed.rows);
        setFileErrors(cleanErrors(parsed.errors));
        return;
      }

      // Plain text formats: CSV, TSV, JSON, HTML, XML, Markdown
      const t = new TextDecoder('utf-8').decode(buf);
      const parsed = parseProspectAuto(t, file.name);
      setFileName(file.name);
      setFileRows(parsed.rows);
      setFileErrors(cleanErrors(parsed.errors));
    } catch (err) {
      setFileErrors([err instanceof Error ? err.message : 'Could not read file']);
    }
  };

  const downloadTemplate = () => {
    const header = 'Company\tProspect Name\tJob Title\tEmail\tPhone\tLocation\tEmployees\tIndustry\n';
    const sample =
      'Acme Corp\tAlex Mercer\tVP of Sales\talex@acme.com\t+1 (555) 019-2834\tAustin, TX\t150\tSaaS\n' +
      'BioGen Labs\tSarah Connor\tHead of Ops\tsarah@biogen.org\t+1 (555) 012-9843\tBoston, MA\t45\tHealthcare\n' +
      'FinEdge Tech\tDavid Miller\tCTO\tdavid@finedge.io\t+1 (555) 014-7721\tNew York, NY\t500\tBFSI\n';
    const blob = new Blob([header + sample], { type: 'text/tab-separated-values;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leads-template.tsv';
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
    // Audio types: mp3, wav, m4a, webm, ogg, flac, aac, wma, mp4, 3gp
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
        setVoiceErrors(['Transcribed but no leads extracted. Edit transcript and click Extract with AI.']);
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

  // Image handlers
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
      lowerName.endsWith('.md');
    if (isTextLike) {
      const t = (await file.text()).trimStart().trim();
      setImageTextFallback(t);
      const parsed = parseProspectAuto(t, file.name);
      setImageRows(parsed.rows);
      setImageErrors(cleanErrors(parsed.errors));
      return;
    }
    try {
      const b64 = await fileToBase64(file);
      setImageBase64(b64);
      setImageErrors([]);
    } catch (err) {
      setImageErrors([err instanceof Error ? err.message : 'Failed to read image']);
    }
  };

  const onImageVoiceFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImageVoiceFileName(file.name);
    setImageErrors(['Transcribing voice note for card…']);
    try {
      const b64 = await fileToBase64(file);
      const out = await api<{ rows: ProspectRow[]; errors: string[]; transcript?: string }>('/api/import/voice/extract', {
        method: 'POST',
        body: JSON.stringify({ audioBase64: b64 }),
      });
      if (out.transcript) {
        setImageVoiceTranscript(out.transcript.trimStart().trim());
        setImageErrors([]);
      } else {
        setImageErrors(['Voice note transcribed as blank. You can type notes manually below.']);
      }
    } catch (err) {
      setImageErrors([err instanceof Error ? err.message : 'Voice transcription failed.']);
    }
  };

  const runImageExtract = async () => {
    const cleanedFallback = imageTextFallback.trimStart().trim();
    const cleanedVoice = imageVoiceTranscript.trimStart().trim();
    if (!imageBase64 && !cleanedFallback && !cleanedVoice) {
      setImageErrors(['Select a business card photo, add fallback text, or supply voice notes.']);
      return;
    }
    setImageErrors([]);
    try {
      const out = await api<{ rows: ProspectRow[]; errors: string[]; text?: string; transcript?: string }>('/api/import/image/extract', {
        method: 'POST',
        body: JSON.stringify({
          imageBase64: imageBase64 ?? undefined,
          mimeType: imageMimeType ?? 'image/jpeg',
          fallbackText: cleanedFallback || undefined,
          transcript: cleanedVoice || undefined,
        }),
      });
      if (out.rows?.length) {
        setImageRows(out.rows);
        setImageErrors(cleanErrors(out.errors ?? []));
        if (out.text && !cleanedFallback) setImageTextFallback(out.text);
        if (out.transcript && !cleanedVoice) setImageVoiceTranscript(out.transcript);
        return;
      }
      runImageFallbackLocal();
    } catch {
      runImageFallbackLocal();
    }
  };

  const runImageFallbackLocal = () => {
    const combinedFallback = [imageVoiceTranscript, imageTextFallback].filter(Boolean).join('\n').trimStart().trim();
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

  const validManualCount = manualLeads.filter((l) => l.company.trim() && l.prospectName.trim()).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <p className="text-xs font-semibold tracking-[0.14em] text-teal-700 uppercase">
          Morning import
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl text-stone-900 sm:text-4xl">
          Import leads
        </h1>
        <p className="mt-2 text-sm text-stone-500">
          Add single or multiple leads at once. Supported across: Manual Entry, Bulk Paste/Files, Voice Audio, and Business Card OCR.
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
            <span>{m === 'single' ? 'Manual Entry' : m === 'bulk' ? 'Bulk import' : m === 'voice' ? 'Voice' : 'Image / Card'}</span>
            {m === 'single' && manualLeads.length > 1 ? (
              <span className="rounded bg-teal-100 px-1.5 py-0.2 text-[10px] font-bold text-teal-800">
                {manualLeads.length}
              </span>
            ) : null}
            {m === 'voice' && !sub.hasVoice ? (
              <span className="rounded bg-amber-100 px-1 py-0.2 text-[10px] font-bold text-amber-800">
                PLUS
              </span>
            ) : null}
            {m === 'image' && !sub.hasImage ? (
              <span className="rounded bg-amber-100 px-1 py-0.2 text-[10px] font-bold text-amber-800">
                PLUS
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {mode === 'single' ? (
        <form onSubmit={runManualImport} className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-stone-600">
              Enter 1 or multiple leads below. Click <span className="font-semibold text-stone-900">+ Add another lead</span> to input more leads.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addManualLead}
                className="inline-flex items-center gap-1 rounded-none border border-teal-600 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800 hover:bg-teal-100"
              >
                <span>+</span> Add another lead
              </button>
              {manualLeads.length > 1 ? (
                <button
                  type="button"
                  onClick={clearManualLeads}
                  className="text-xs text-stone-500 hover:text-rose-600"
                >
                  Reset form
                </button>
              ) : null}
            </div>
          </div>

          <div className="space-y-4">
            {manualLeads.map((lead, idx) => {
              const previewScore = lead.company.trim() && lead.prospectName.trim()
                ? scoreProspect(
                    {
                      company: lead.company,
                      prospectName: lead.prospectName,
                      jobTitle: lead.jobTitle,
                      email: lead.email.toLowerCase(),
                      phone: lead.phone,
                      location: lead.location,
                      employees: lead.employees ? Number(lead.employees.replace(/[^0-9]/g, '')) || null : null,
                      industry: lead.industry,
                      description: lead.description,
                    },
                    icp
                  )
                : null;

              return (
                <div
                  key={lead.id}
                  className="relative rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5 space-y-4"
                >
                  <div className="flex items-center justify-between border-b border-[var(--color-line)] pb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-stone-100 text-[11px] font-bold text-stone-700">
                        {idx + 1}
                      </span>
                      <h3 className="text-sm font-semibold text-stone-800">
                        {lead.company.trim() || lead.prospectName.trim()
                          ? `${lead.prospectName || 'Lead'} — ${lead.company || 'Company'}`
                          : `Lead Entry #${idx + 1}`}
                      </h3>
                    </div>
                    <div className="flex items-center gap-2">
                      {previewScore ? (
                        <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[11px] font-semibold ${scoreColor(previewScore.score)}`}>
                          Score: {scoreLabel(previewScore.score)} ({previewScore.score}/10)
                        </span>
                      ) : null}
                      {manualLeads.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => removeManualLead(lead.id)}
                          className="text-xs font-semibold text-stone-400 hover:text-rose-600"
                          title="Remove this lead"
                        >
                          ✕ Remove
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Company *">
                      <input
                        className={inputClass}
                        value={lead.company}
                        onChange={(e) => updateManualLead(lead.id, 'company', e.target.value)}
                        placeholder="e.g. Acme Health"
                        required
                      />
                    </Field>
                    <Field label="Prospect Name *">
                      <input
                        className={inputClass}
                        value={lead.prospectName}
                        onChange={(e) => updateManualLead(lead.id, 'prospectName', e.target.value)}
                        placeholder="e.g. Dr. Alex Mercer"
                        required
                      />
                    </Field>
                    <Field label="Job Title">
                      <input
                        className={inputClass}
                        value={lead.jobTitle}
                        onChange={(e) => updateManualLead(lead.id, 'jobTitle', e.target.value)}
                        placeholder="e.g. Chief Medical Officer"
                      />
                    </Field>
                    <Field label="Work Email">
                      <input
                        type="email"
                        className={inputClass}
                        value={lead.email}
                        onChange={(e) => updateManualLead(lead.id, 'email', e.target.value)}
                        placeholder="alex@acmehealth.com"
                      />
                    </Field>
                    <Field label="Phone">
                      <input
                        className={inputClass}
                        value={lead.phone}
                        onChange={(e) => updateManualLead(lead.id, 'phone', e.target.value)}
                        placeholder="+1 (555) 019-2834"
                      />
                    </Field>
                    <Field label="Location">
                      <input
                        className={inputClass}
                        value={lead.location}
                        onChange={(e) => updateManualLead(lead.id, 'location', e.target.value)}
                        placeholder="Austin, TX"
                      />
                    </Field>
                    <Field label="Employees / Headcount">
                      <input
                        className={inputClass}
                        inputMode="numeric"
                        value={lead.employees}
                        onChange={(e) => updateManualLead(lead.id, 'employees', e.target.value)}
                        placeholder="150"
                      />
                    </Field>
                    <Field label="Industry">
                      <input
                        className={inputClass}
                        value={lead.industry}
                        onChange={(e) => updateManualLead(lead.id, 'industry', e.target.value)}
                        placeholder="Healthcare, SaaS, BFSI, Retail..."
                      />
                    </Field>
                    <Field label="Context / Notes / Description" className="sm:col-span-2">
                      <input
                        className={inputClass}
                        value={lead.description}
                        onChange={(e) => updateManualLead(lead.id, 'description', e.target.value)}
                        placeholder="Key requirements, conversation takeaway, or discovery note"
                      />
                    </Field>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={addManualLead}
              className={`${btnGhost} text-xs`}
            >
              + Add another lead
            </button>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                className={btnPrimary}
                disabled={busy || validManualCount === 0}
              >
                {busy
                  ? 'Importing leads…'
                  : validManualCount > 1
                  ? `Import All ${validManualCount} Leads`
                  : 'Import Lead'}
              </button>
            </div>
          </div>

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
              Paste multiple leads (TSV, CSV, Excel, JSON, HTML tables, Markdown, or text)
            </label>
            <textarea
              className={`${inputClass} mt-1.5 h-48 font-mono text-xs`}
              placeholder={`Paste any table or list of leads...\n\nExample:\nAcme Corp\tAlex Mercer\tVP of Sales\talex@acme.com\t+1 (555) 019-2834\tAustin, TX\t150\tSaaS\nBioGen Labs\tSarah Connor\tHead of Ops\tsarah@biogen.org\t+1 (555) 012-9843\tBoston, MA\t45\tHealthcare`}
              value={text}
              onChange={(e) => {
                setFileName(null);
                setFileRows([]);
                setFileErrors([]);
                setText(e.target.value);
              }}
            />

            {bulkErrors.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs text-amber-800">
                {bulkErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={btnPrimary}
                disabled={busy || bulkRows.length === 0}
                onClick={runBulkImport}
              >
                {busy
                  ? 'Importing…'
                  : bulkRows.length > 0
                  ? `Import all ${bulkRows.length} row${bulkRows.length > 1 ? 's' : ''}`
                  : 'Import rows'}
              </button>
              {bulkRows.length > 0 ? (
                <span className="text-xs text-stone-500">
                  {bulkRows.length} valid prospect{bulkRows.length > 1 ? 's' : ''} across {byCompany.length} compan{byCompany.length === 1 ? 'y' : 'ies'}
                </span>
              ) : null}
            </div>

            {lastResult && mode === 'bulk' ? (
              <p className={`mt-3 rounded-none px-3 py-2 text-sm ${resultBannerClass(lastResult.ok)}`}>
                {lastResult.message}
              </p>
            ) : null}
          </div>

          {bulkRows.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-stone-900">
                  Preview ({bulkRows.length} rows to import)
                </h3>
              </div>
              <div className="overflow-x-auto rounded-none border border-[var(--color-line)] bg-[var(--color-panel)]">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[var(--color-line)] bg-stone-50 text-stone-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Company</th>
                      <th className="px-3 py-2 font-semibold">Prospect</th>
                      <th className="px-3 py-2 font-semibold">Title</th>
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Phone</th>
                      <th className="px-3 py-2 font-semibold">Industry</th>
                      <th className="px-3 py-2 font-semibold">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-line)]/50">
                    {scoredBulk.map(({ row: r, score }, i) => (
                      <tr key={i} className="hover:bg-stone-50/50">
                        <td className="px-3 py-2 font-medium text-stone-900">{r.company}</td>
                        <td className="px-3 py-2 text-stone-700">{r.prospectName}</td>
                        <td className="px-3 py-2 text-stone-500">{r.jobTitle || '—'}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-stone-500">{r.email || '—'}</td>
                        <td className="px-3 py-2 text-stone-500">{r.phone || '—'}</td>
                        <td className="px-3 py-2 text-stone-500">{r.industry || '—'}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[11px] font-semibold ${scoreColor(score.score)}`}>
                            {scoreLabel(score.score)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {mode === 'voice' ? (
        <div className="space-y-4 rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          {!sub.hasVoice ? (
            <div className="rounded-none border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
              Voice AI lead extraction requires the <span className="font-semibold">Plus or Pro Plan</span>.
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={isRecording ? stopRecording : startRecording}
              className={`${btnPrimary} ${isRecording ? 'bg-rose-600 hover:bg-rose-700' : ''}`}
              disabled={voiceBusy || !sub.hasVoice}
            >
              {isRecording ? `⏹ Stop Recording (${recordSeconds}s)` : '🎙 Record Voice Note'}
            </button>
            <label className={`${btnGhost} cursor-pointer`}>
              Upload Audio File
              <input
                type="file"
                accept="audio/*,.webm,.wav,.mp3,.m4a,.ogg,.flac,.aac"
                className="hidden"
                onChange={onVoiceFile}
                disabled={voiceBusy || !sub.hasVoice}
              />
            </label>
            {voiceFileName ? (
              <span className="text-xs text-stone-500">{voiceFileName}</span>
            ) : null}
          </div>

          <Field label="Voice Transcript">
            <textarea
              className={`${inputClass} h-32 text-xs`}
              placeholder="Spoken notes or voice transcript will appear here..."
              value={voiceTranscript}
              onChange={(e) => setVoiceTranscript(e.target.value)}
            />
          </Field>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={runVoiceExtract}
              className={btnPrimary}
              disabled={voiceBusy || !voiceTranscript.trim()}
            >
              {voiceBusy ? 'Extracting with AI…' : 'Extract Leads with AI'}
            </button>
          </div>

          {voiceErrors.length > 0 ? (
            <ul className="space-y-1 text-xs text-amber-800">
              {voiceErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          ) : null}

          {voiceRows.length > 0 ? (
            <div className="space-y-3 pt-3 border-t border-[var(--color-line)]">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-stone-700">
                  Extracted Leads ({voiceRows.length})
                </h4>
                <button
                  type="button"
                  onClick={runVoiceImport}
                  className={btnPrimary}
                  disabled={busy}
                >
                  {busy ? 'Importing…' : `Import All ${voiceRows.length} Voice Leads`}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[var(--color-line)] bg-stone-50 text-stone-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Company</th>
                      <th className="px-3 py-2 font-semibold">Prospect</th>
                      <th className="px-3 py-2 font-semibold">Title</th>
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Phone</th>
                      <th className="px-3 py-2 font-semibold">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-line)]/50">
                    {scoredVoice.map(({ row: r, score }, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 font-medium text-stone-900">{r.company}</td>
                        <td className="px-3 py-2 text-stone-700">{r.prospectName}</td>
                        <td className="px-3 py-2 text-stone-500">{r.jobTitle || '—'}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-stone-500">{r.email || '—'}</td>
                        <td className="px-3 py-2 text-stone-500">{r.phone || '—'}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[11px] font-semibold ${scoreColor(score.score)}`}>
                            {scoreLabel(score.score)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {lastResult && mode === 'voice' ? (
            <p className={`rounded-none px-3 py-2 text-sm ${resultBannerClass(lastResult.ok)}`}>
              {lastResult.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {mode === 'image' ? (
        <div className="space-y-4 rounded-none border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
          {!sub.hasImage ? (
            <div className="rounded-none border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
              Business card OCR requires the <span className="font-semibold">Plus or Pro Plan</span>.
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <label className={`${btnPrimary} cursor-pointer`}>
              📸 Take Photo / Upload Card
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={onImageFile}
                disabled={!sub.hasImage}
              />
            </label>
            <label className={`${btnGhost} cursor-pointer`}>
              🎙 Attach Voice Notes for Card
              <input
                type="file"
                accept="audio/*,.webm,.wav,.mp3,.m4a"
                className="hidden"
                onChange={onImageVoiceFile}
                disabled={!sub.hasImage}
              />
            </label>
            {imageFileName ? (
              <span className="text-xs text-stone-500">Image: {imageFileName}</span>
            ) : null}
            {imageVoiceFileName ? (
              <span className="text-xs text-stone-500">Voice Note: {imageVoiceFileName}</span>
            ) : null}
          </div>

          {imagePreviewUrl ? (
            <div className="flex max-w-xs items-center gap-3 rounded-none border border-[var(--color-line)] p-2">
              <img
                src={imagePreviewUrl}
                alt="Business card preview"
                className="max-h-32 object-contain"
              />
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="OCR Text Fallback (Optional)">
              <textarea
                className={`${inputClass} h-24 text-xs`}
                placeholder="Pasted business card text or OCR transcript..."
                value={imageTextFallback}
                onChange={(e) => setImageTextFallback(e.target.value)}
              />
            </Field>
            <Field label="Voice Notes on Card (Optional)">
              <textarea
                className={`${inputClass} h-24 text-xs`}
                placeholder="Spoken notes on lead conversation context..."
                value={imageVoiceTranscript}
                onChange={(e) => setImageVoiceTranscript(e.target.value)}
              />
            </Field>
          </div>

          <button
            type="button"
            onClick={runImageExtract}
            className={btnPrimary}
            disabled={!imageBase64 && !imageTextFallback.trim() && !imageVoiceTranscript.trim()}
          >
            Extract Leads from Image & Voice
          </button>

          {imageErrors.length > 0 ? (
            <ul className="space-y-1 text-xs text-amber-800">
              {imageErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          ) : null}

          {imageRows.length > 0 ? (
            <div className="space-y-3 pt-3 border-t border-[var(--color-line)]">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-stone-700">
                  Extracted Leads ({imageRows.length})
                </h4>
                <button
                  type="button"
                  onClick={runImageImport}
                  className={btnPrimary}
                  disabled={busy}
                >
                  {busy ? 'Importing…' : `Import All ${imageRows.length} Image Leads`}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[var(--color-line)] bg-stone-50 text-stone-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Company</th>
                      <th className="px-3 py-2 font-semibold">Prospect</th>
                      <th className="px-3 py-2 font-semibold">Title</th>
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Phone</th>
                      <th className="px-3 py-2 font-semibold">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-line)]/50">
                    {scoredImage.map(({ row: r, score }, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 font-medium text-stone-900">{r.company}</td>
                        <td className="px-3 py-2 text-stone-700">{r.prospectName}</td>
                        <td className="px-3 py-2 text-stone-500">{r.jobTitle || '—'}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-stone-500">{r.email || '—'}</td>
                        <td className="px-3 py-2 text-stone-500">{r.phone || '—'}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[11px] font-semibold ${scoreColor(score.score)}`}>
                            {scoreLabel(score.score)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {lastResult && mode === 'image' ? (
            <p className={`rounded-none px-3 py-2 text-sm ${resultBannerClass(lastResult.ok)}`}>
              {lastResult.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
