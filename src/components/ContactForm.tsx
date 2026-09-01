import { useState, type FormEvent } from 'react';
import type { Contact, Stage } from '../types';
import { DEFAULT_CONTACT_STATUSES, DEFAULT_STAGES } from '../defaults';
import type { CrmStore } from '../hooks/useCrmStore';
import { normalizeOptionalUrl } from '../lib/urls';
import { Field, inputClass, btnPrimary, btnGhost, Modal } from './ui';
import { ConversationPanel } from './ConversationPanel';

interface ContactFormProps {
  store: CrmStore;
  contactStatuses?: string[];
  stages?: string[];
  initial?: Contact | null;
  defaultCompanyId?: string | null;
  onDone: () => void;
}

export function ContactForm({
  store,
  contactStatuses = [...DEFAULT_CONTACT_STATUSES],
  stages = [...DEFAULT_STAGES],
  initial,
  defaultCompanyId,
  onDone,
}: ContactFormProps) {
  const [form, setForm] = useState({
    contactName: initial?.contactName ?? '',
    companyId: initial?.companyId ?? defaultCompanyId ?? '',
    role: initial?.role ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
    linkedInProfile: initial?.linkedInProfile ?? '',
    contactStatus: initial?.contactStatus ?? contactStatuses[0] ?? 'Not Contacted',
    champion: initial?.champion ?? false,
    lastContacted: initial?.lastContacted ? String(initial.lastContacted).slice(0, 10) : '',
    nextFollowUp: initial?.nextFollowUp ? String(initial.nextFollowUp).slice(0, 10) : '',
    description: initial?.description ?? '',
    notes: initial?.notes ?? '',
  });
  const [stageBusy, setStageBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const set = (key: string, value: string | boolean) => {
    setError(null);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const linkedCompany = form.companyId
    ? store.companies.find((c) => c.id === form.companyId)
    : undefined;

  const onCompanyStageChange = async (stage: string) => {
    if (!form.companyId || !linkedCompany || stage === linkedCompany.stage) return;
    setStageBusy(true);
    setError(null);
    try {
      await store.moveCompanyStage(form.companyId, stage as Stage, {
        stageChangeSource: 'contact_form',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update company stage');
    } finally {
      setStageBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.contactName.trim()) {
      setError('Contact name is required');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        contactName: form.contactName.trim(),
        companyId: form.companyId ? form.companyId.trim() : null,
        role: form.role.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        linkedInProfile: normalizeOptionalUrl(form.linkedInProfile),
        contactStatus: form.contactStatus,
        champion: form.champion,
        lastContacted: form.lastContacted ? form.lastContacted.slice(0, 10) : null,
        nextFollowUp: form.nextFollowUp ? form.nextFollowUp.slice(0, 10) : null,
        description: form.description.trim(),
        notes: form.notes.trim(),
      };

      if (initial) {
        await store.updateContact(initial.id, payload);
      } else {
        await store.addContact(payload);
      }
      onDone();
    } catch (err) {
      console.error('Contact save failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to save contact');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact Name *" className="sm:col-span-2">
          <input
            className={inputClass}
            value={form.contactName}
            onChange={(e) => set('contactName', e.target.value)}
            required
            placeholder="Full name"
          />
        </Field>

        <Field label="Company">
          <select
            className={inputClass}
            value={form.companyId}
            onChange={(e) => set('companyId', e.target.value)}
          >
            <option value="">— None —</option>
            {store.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName}
              </option>
            ))}
          </select>
        </Field>

        {form.companyId ? (
          <div className="flex flex-col justify-end gap-2">
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                const url = `${window.location.origin}/?page=pipeline&companyId=${encodeURIComponent(form.companyId)}`;
                window.open(url, '_blank', 'noopener,noreferrer');
              }}
            >
              Open company
            </button>
          </div>
        ) : null}

        {form.companyId ? (
          <Field label="Company pipeline stage">
            <select
              className={inputClass}
              value={linkedCompany?.stage ?? stages[0] ?? ''}
              disabled={!linkedCompany || stageBusy}
              onChange={(e) => void onCompanyStageChange(e.target.value)}
              aria-label="Company pipeline stage"
            >
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label="Role / Designation">
          <input
            className={inputClass}
            value={form.role}
            onChange={(e) => set('role', e.target.value)}
            placeholder="e.g. VP Operations"
          />
        </Field>

        <Field label="Phone Number">
          <input
            className={inputClass}
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            className={inputClass}
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </Field>

        <Field label="Contact Status">
          <select
            className={inputClass}
            value={form.contactStatus}
            onChange={(e) => set('contactStatus', e.target.value)}
          >
            {contactStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Last Contacted">
          <input
            type="date"
            className={inputClass}
            value={form.lastContacted}
            onChange={(e) => set('lastContacted', e.target.value)}
          />
        </Field>

        <Field label="Next Follow-up">
          <input
            type="date"
            className={inputClass}
            value={form.nextFollowUp}
            onChange={(e) => set('nextFollowUp', e.target.value)}
          />
        </Field>

        <Field label="LinkedIn Profile" className="sm:col-span-2">
          <input
            type="text"
            inputMode="url"
            autoComplete="url"
            className={inputClass}
            value={form.linkedInProfile}
            onChange={(e) => set('linkedInProfile', e.target.value)}
            placeholder="linkedin.com/in/… or https://…"
          />
        </Field>

        <Field label="Description / Context (for AI scoring)" className="sm:col-span-2">
          <textarea
            className={`${inputClass} min-h-[60px] resize-y text-sm`}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="e.g. Key decision maker, interested in automated call transcription and CRM sync"
          />
        </Field>

        <Field label="Notes" className="sm:col-span-2">
          <textarea
            className={`${inputClass} min-h-[80px] resize-y`}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>

        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={form.champion}
            onChange={(e) => set('champion', e.target.checked)}
            className="h-4 w-4 rounded-none border-stone-300 text-teal-700 focus:ring-teal-600"
          />
          <span className="font-medium text-stone-700">
            Champion{' '}
            <span className="font-normal text-stone-500">
              (auto-sets as Primary Contact on the company)
            </span>
          </span>
        </label>
      </div>

      {initial ? (
        <ConversationPanel
          store={store}
          contactId={initial.id}
          companyId={form.companyId || initial.companyId}
          stages={stages}
        />
      ) : (
        <p className="rounded-none border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-500">
          Save this contact first to upload call recordings.
        </p>
      )}

      {error ? (
        <p className="rounded-none border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-line)] pt-4">
        {initial && store.canDelete ? (
          <button
            type="button"
            className="text-sm text-rose-600 hover:underline"
            onClick={() => setConfirmDelete(true)}
            disabled={busy || deleteBusy}
          >
            Delete contact
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" className={btnGhost} onClick={onDone} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary} disabled={busy}>
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Add contact'}
          </button>
        </div>
      </div>

      {initial ? (
        <Modal open={confirmDelete} title={`Delete ${initial.contactName}?`} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-stone-600">
            This will permanently delete <span className="font-semibold text-stone-900">{initial.contactName}</span> and unlink it from its company. This action cannot be undone.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setConfirmDelete(false)} disabled={deleteBusy}>
              Cancel
            </button>
            <button
              type="button"
              className={btnPrimary + ' bg-rose-600 hover:bg-rose-700'}
              disabled={deleteBusy}
              onClick={async () => {
                setDeleteBusy(true);
                try {
                  await store.deleteContact(initial.id);
                  setConfirmDelete(false);
                  onDone();
                } finally {
                  setDeleteBusy(false);
                }
              }}
            >
              {deleteBusy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Modal>
      ) : null}
    </form>
  );
}
