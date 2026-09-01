import { useCallback, useEffect, useState, useRef } from 'react';
import type { Conversation, Stage } from '../types';
import { DEFAULT_STAGES } from '../defaults';
import type { CrmStore } from '../hooks/useCrmStore';
import {
  deleteConversation,
  getPlayUrl,
  listConversations,
  uploadConversationRecording,
} from '../lib/conversations';
import { Field, inputClass, btnGhost, btnPrimary, Modal } from './ui';

interface ConversationPanelProps {
  store: CrmStore;
  contactId: string;
  companyId: string | null;
  stages?: string[];
}

function formatCalledAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export function ConversationPanel({
  store,
  contactId,
  companyId,
  stages = [...DEFAULT_STAGES],
}: ConversationPanelProps) {
  const company = companyId ? store.getCompany(companyId) : null;
  const [stageAtCall, setStageAtCall] = useState<Stage>(
    company?.stage ?? stages[0] ?? 'Lead Added'
  );
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingDelete = pendingDeleteId ? items.find((c) => c.id === pendingDeleteId) : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listConversations({ contactId });
      setItems(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load recordings');
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (company?.stage) setStageAtCall(company.stage);
  }, [company?.stage]);

  const upload = async () => {
    if (!file) {
      setError('Choose an audio file first');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const created = await uploadConversationRecording(contactId, stageAtCall, file, notes || undefined);
      try {
        const reader = new FileReader();
        const b64: string = await new Promise((resolve, reject) => {
          reader.onload = () => {
            const res = reader.result as string;
            resolve(res.split(',')[1] ?? '');
          };
          reader.onerror = () => reject(new Error('read'));
          reader.readAsDataURL(file);
        });
        if (b64 && (created as unknown as { id?: string })?.id) {
          const convId = (created as unknown as { id: string }).id ?? (created as unknown as { conversationId?: string })?.conversationId;
          if (convId) {
            // fire-and-forget transcribe for phone path — strict prompt, updates score
            fetch(`/api/conversations/${convId}/transcribe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('zcrm-token') ?? ''}` },
              body: JSON.stringify({ audioBase64: b64, mimeType: file.type || 'audio/webm' }),
            }).catch(() => {});
          }
        }
      } catch {}
      setFile(null);
      setNotes('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined });
      const chunks: BlobPart[] = [];
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        const f = new File([blob], `recording-${Date.now()}.webm`, { type: blob.type });
        setFile(f);
        setError(null);
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        setIsRecording(false);
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setError('Microphone not available on this device.');
    }
  };

  const stopRec = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
  };

  const transcribeNow = async (id: string) => {
    setTranscribingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${id}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('zcrm-token') ?? ''}` },
        body: JSON.stringify({ audioBase64: '', mimeType: 'audio/webm' }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? 'Transcribe failed');
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed');
    } finally {
      setTranscribingId(null);
    }
  };

  const play = async (id: string) => {
    try {
      const url = await getPlayUrl(id);
      setPlayingId(id);
      setPlayUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Playback failed');
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteConversation(id);
      if (playingId === id) {
        setPlayingId(null);
        setPlayUrl(null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setPendingDeleteId(null);
    }
  };

  return (
    <div className="space-y-4 rounded-none border border-[var(--color-line)] bg-stone-50/50 p-4">
      <div>
        <h3 className="text-sm font-semibold text-stone-800">Call recordings</h3>
        <p className="mt-1 text-xs text-stone-500">
          Set the company stage for this call before uploading. Time is saved automatically when the
          file reaches storage.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Stage at call">
          <select
            className={inputClass}
            value={stageAtCall}
            onChange={(e) => setStageAtCall(e.target.value as Stage)}
          >
            {stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Audio file (mp3, m4a, wav, webm) — phone capture">
          <input
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg,.aac,.mp4"
            capture
            className={inputClass}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {!isRecording ? (
              <button type="button" className={btnGhost} onClick={() => void startRec()}>
                Record on phone
              </button>
            ) : (
              <button type="button" className={btnPrimary} onClick={stopRec}>
                Stop ({recordSeconds}s)
              </button>
            )}
            {file ? <span className="text-xs text-stone-500">{file.name} ({Math.round(file.size / 1024)}KB)</span> : null}
          </div>
          <p className="mt-1 text-xs text-stone-500">On phone, choose file or tap Record. Recording is transcribed and analysed to update lead score.</p>
        </Field>
        <Field label="Notes (optional)" className="sm:col-span-2">
          <input
            className={inputClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Quick call summary"
          />
        </Field>
      </div>

      <button
        type="button"
        className={btnPrimary}
        disabled={uploading || !file}
        onClick={() => void upload()}
      >
        {uploading ? 'Uploading…' : 'Upload & analyse'}
      </button>

      {error ? (
        <p className="rounded-none bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      ) : null}

      {playUrl ? (
        <audio controls className="w-full" src={playUrl} autoPlay>
          <track kind="captions" />
        </audio>
      ) : null}

      <div>
        <p className="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
          History ({items.length})
        </p>
        {loading ? (
          <p className="text-xs text-stone-400">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-stone-400">No recordings yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-none border border-[var(--color-line)] bg-white">
            {items.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 text-xs">
                  <p className="font-medium text-stone-800">{formatCalledAt(c.calledAt)}</p>
                  <p className="text-stone-500">
                    {c.calledByName} · stage: {c.stageAtCall}
                  </p>
                  {c.notes ? <p className="mt-0.5 text-stone-400">{c.notes}</p> : null}
                  {c.transcript ? (
                    <p className="mt-1 rounded-none bg-stone-50 px-2 py-1 text-xs text-stone-600">{c.transcript.slice(0, 180)}{c.transcript.length > 180 ? '…' : ''}</p>
                  ) : null}
                  {c.analysis?.summary ? (
                    <p className="mt-1 text-xs text-teal-700">
                      {c.analysis.tier ? `${c.analysis.tier} ${c.analysis.score ?? ''} · ` : ''}
                      {c.analysis.summary}
                    </p>
                  ) : null}
                  {c.analysis?.reasons?.length ? (
                    <p className="mt-0.5 text-[11px] text-stone-400">{(c.analysis.reasons as string[]).join(' · ')}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <div className="flex gap-2">
                    <button type="button" className={btnGhost} onClick={() => void play(c.id)}>
                      Play
                    </button>
                    {store.canDelete ? (
                      <button
                        type="button"
                        className="text-xs text-rose-600 hover:underline"
                        onClick={() => setPendingDeleteId(c.id)}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                  {!c.transcript ? (
                    <button
                      type="button"
                      className="text-[11px] font-medium text-teal-700 hover:underline"
                      onClick={() => void transcribeNow(c.id)}
                      disabled={transcribingId === c.id}
                    >
                      {transcribingId === c.id ? 'Transcribing…' : 'Transcribe'}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
            <Modal
              open={!!pendingDeleteId}
              title={pendingDelete ? `Delete recording from ${formatCalledAt(pendingDelete.calledAt)}?` : 'Delete recording?'}
              onClose={() => setPendingDeleteId(null)}
            >
              <p className="text-sm text-stone-600">
                This will permanently delete the recording
                {pendingDelete ? (
                  <span className="font-semibold text-stone-900"> {pendingDelete.calledByName} · {pendingDelete.stageAtCall}</span>
                ) : null}{' '}
                and cannot be undone.
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <button type="button" className={btnGhost} onClick={() => setPendingDeleteId(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={btnPrimary + ' bg-rose-600 hover:bg-rose-700'}
                  onClick={() => pendingDeleteId && void remove(pendingDeleteId)}
                >
                  Delete
                </button>
              </div>
            </Modal>
          </ul>
        )}
      </div>
    </div>
  );
}
