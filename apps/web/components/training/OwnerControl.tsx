"use client";

import { useEffect, useRef, useState } from "react";

import { useTraining } from "./TrainingProvider";

/**
 * Owner mode in the masthead. The section is public; unlocking it lets the
 * owner edit goals, athlete settings and the maintenance log. The passphrase
 * is exchanged for an HTTP-only cookie, so nothing here ever holds a secret
 * beyond the moment it is typed.
 */
export default function OwnerControl() {
  const { admin } = useTraining();
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // Clicking anywhere else, or Escape, closes the popover.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (admin.authenticated) {
    return (
      <button
        className="t-owner is-active"
        type="button"
        onClick={() => void admin.lock().catch((reason: unknown) => setError(String(reason)))}
        title="Owner mode is on: goals, settings and maintenance are editable. Click to lock."
      >
        <span className="dot" aria-hidden="true" />
        Owner · Lock
      </button>
    );
  }

  return (
    <div className="t-owner-wrap" ref={wrapper}>
      <button
        className="t-owner"
        type="button"
        aria-expanded={open}
        aria-controls="t-owner-popover"
        onClick={() => setOpen((value) => !value)}
      >
        Owner
      </button>
      {open && (
        <form
          id="t-owner-popover"
          className="t-owner-popover"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await admin.unlock(passphrase);
              setPassphrase("");
              setOpen(false);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : "Could not unlock");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="t-owner-passphrase">Owner passphrase</label>
          <div className="t-input-row">
            <input
              className="t-input"
              autoComplete="current-password"
              autoFocus
              id="t-owner-passphrase"
              onChange={(event) => setPassphrase(event.target.value)}
              type="password"
              value={passphrase}
            />
            <button className="t-button" disabled={busy || !passphrase} type="submit">
              {busy ? "Checking…" : "Unlock"}
            </button>
          </div>
          <p className="t-note">
            Training is public. Owner mode edits goals, athlete settings and the maintenance log.
          </p>
          {error && (
            <p className="t-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
