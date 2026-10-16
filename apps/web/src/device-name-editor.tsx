import { useId, useState } from "react";

/** The parent owns the persisted name; failed edits stay available for retry. */
export function DeviceNameEditor({ name, onSave, disabled = false, renameLabel = "Rename device" }: {
 name: string; onSave(name: string): Promise<string>; disabled?: boolean; renameLabel?: string;
}) {
 const id = useId();
 const [editing, setEditing] = useState(false);
 const [draft, setDraft] = useState(name);
 const [error, setError] = useState<string>();
 const [busy, setBusy] = useState(false);
 return <div className="device-name-editor">
  {editing ? <form noValidate onSubmit={event => {
   event.preventDefault(); if (busy || disabled) return;
   const value = draft.trim();
   if (!value || value.length > 80) { setError("Use 1–80 characters for the device name."); return; }
   setBusy(true); setError(undefined);
   void onSave(value).then(() => { setEditing(false); }).catch(() => setError("Could not save the device name. Try again.")).finally(() => setBusy(false));
  }}>
   <label htmlFor={id}>Device name</label>
   <input id={id} className="rename-input" autoFocus value={draft} maxLength={80} disabled={busy || disabled} onChange={event => setDraft(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} autoComplete="off" />
   <div className="dialog-buttons"><button type="button" disabled={busy} onClick={() => { setEditing(false); setError(undefined); }}>Cancel</button><button className="primary" type="submit" disabled={busy || disabled}>{busy ? "Saving…" : "Save device name"}</button></div>
   {error ? <p id={`${id}-error`} className="dialog-error" role="alert">{error}</p> : null}
  </form> : <div className="setting-row"><span>Device name<small>{name}</small></span><button type="button" disabled={disabled} aria-label={renameLabel} onClick={() => { setDraft(name); setError(undefined); setEditing(true); }}>Rename</button></div>}
 </div>;
}
