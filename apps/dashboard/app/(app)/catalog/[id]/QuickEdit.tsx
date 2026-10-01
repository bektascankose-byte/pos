"use client";

import { useEffect, useRef, useState } from "react";
import type { Variant } from "@snappos/contracts";
import { parseSpoken, type SpokenCommand } from "./speech";
import { quickBarcodeAction, quickCountAction, quickUnitsPerBoxAction } from "./quick-edit-actions";

/**
 * Quick edit: walk every flavor of an item, one box at a time, by voice and
 * by scanner, without touching the keyboard.
 *
 * The order inside a flavor is fixed: singles per box, boxes on hand, singles
 * on hand, the single's barcode, the box's barcode. Each mode uses the part of
 * that it needs. Singles per box is asked once and carried to every flavor
 * after it, so on the second flavor the cursor starts at boxes on hand.
 *
 * Saving happens as it goes. Barcodes are saved the moment they are scanned,
 * so a code already on another item is reported while the box is still in
 * hand. Counts and box size are saved when the flavor is left, as one count
 * movement for the total on hand. Close saves and remembers the flavor it was
 * on, in this browser, so the button on the Variants tab can pick it back up.
 */
export type QuickEditMode = "count" | "barcodes" | "both";

type Field = "perBox" | "cartons" | "singles" | "unitCode" | "cartonCode";

const FIELDS: Record<QuickEditMode, Field[]> = {
  count: ["perBox", "cartons", "singles"],
  barcodes: ["perBox", "unitCode", "cartonCode"],
  both: ["perBox", "cartons", "singles", "unitCode", "cartonCode"],
};

export const MODE_LABEL: Record<QuickEditMode, { start: string; resume: string }> = {
  count: { start: "Count stock", resume: "Continue counting" },
  barcodes: { start: "Add barcodes", resume: "Continue barcodes" },
  both: { start: "Count and barcodes", resume: "Continue count and barcodes" },
};

const FIELD_LABEL: Record<Field, string> = {
  perBox: "Singles in a box",
  cartons: "Boxes on hand",
  singles: "Singles on hand",
  unitCode: "Single barcode",
  cartonCode: "Box barcode",
};

interface Entry {
  perBox: string;
  cartons: string;
  singles: string;
  unitCode: string;
  cartonCode: string;
  /** What the server holds, so an unchanged box size is never written. */
  savedPerBox: string;
  savedCount: string | null;
  unitSaved: string | null;
  cartonSaved: string | null;
  note: string | null;
  error: string | null;
}

export interface QuickEditResume {
  variantId: string;
  carried: string;
}

const resumeKey = (productId: string, mode: QuickEditMode) => `snappos.quickedit.${productId}.${mode}`;

export function readResume(productId: string, mode: QuickEditMode): QuickEditResume | null {
  try {
    const raw = window.localStorage.getItem(resumeKey(productId, mode));
    return raw ? (JSON.parse(raw) as QuickEditResume) : null;
  } catch {
    return null;
  }
}

export function clearResume(productId: string, mode: QuickEditMode) {
  try {
    window.localStorage.removeItem(resumeKey(productId, mode));
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

function writeResume(productId: string, mode: QuickEditMode, resume: QuickEditResume) {
  try {
    window.localStorage.setItem(resumeKey(productId, mode), JSON.stringify(resume));
  } catch {
    /* storage unavailable: closing still saves the work, only the place is lost */
  }
}

const isCodeField = (field: Field) => field === "unitCode" || field === "cartonCode";

/** The slice of the Web Speech API this uses. Chrome and Edge ship it as `webkitSpeechRecognition`. */
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export function QuickEdit({
  productId,
  productName,
  variants,
  mode,
  resume,
  onClose,
}: {
  productId: string;
  productName: string;
  /** On sale flavors, in the order the Variants tab shows them. */
  variants: Variant[];
  mode: QuickEditMode;
  resume: QuickEditResume | null;
  onClose: () => void;
}) {
  const fields = FIELDS[mode];

  // The working state lives in a ref, not in React state: voice commands
  // arrive faster than renders, and each must see what the one before it did.
  // `tick` only asks React to draw it again.
  const session = useRef<{ index: number; field: Field; carried: string; entries: Map<string, Entry> } | null>(null);
  const [, setTick] = useState(0);
  const redraw = () => setTick((t) => t + 1);

  const entryFor = (variant: Variant): Entry => {
    const s = session.current!;
    let entry = s.entries.get(variant.id);
    if (!entry) {
      const own = Number(variant.case_quantity) > 1 ? String(variant.case_quantity) : "";
      entry = {
        perBox: s.carried || own,
        cartons: "",
        singles: "",
        unitCode: "",
        cartonCode: "",
        savedPerBox: String(variant.case_quantity),
        savedCount: null,
        unitSaved: null,
        cartonSaved: null,
        note: null,
        error: null,
      };
      s.entries.set(variant.id, entry);
    }
    return entry;
  };

  const startField = (entry: Entry): Field => (entry.perBox ? fields[1]! : fields[0]!);

  if (session.current === null) {
    const at = resume ? Math.max(0, variants.findIndex((v) => v.id === resume.variantId)) : 0;
    session.current = { index: at, field: "perBox", carried: resume?.carried ?? "", entries: new Map() };
    const first = variants[at];
    if (first) session.current.field = startField(entryFor(first));
  }

  const s = session.current;
  const variant = variants[s.index];
  const entry = variant ? entryFor(variant) : null;
  /**
   * The flavor and box as they are now. Every handler reads through this
   * rather than the values above, which belong to the last render and go
   * stale the moment a command moves to the next flavor.
   */
  const cur = () => {
    const v = variants[s.index];
    return { variant: v, entry: v ? entryFor(v) : null };
  };
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Save what this flavor holds that has not been saved yet. False when something was refused. */
  const commit = async (target: Variant): Promise<boolean> => {
    const e = entryFor(target);
    e.error = null;
    const perBox = Number(e.perBox);
    // Whatever this flavor's box holds is the guess for the flavors after it.
    if (e.perBox && perBox >= 1) session.current!.carried = String(perBox);
    if (e.perBox && Number.isInteger(perBox) && perBox >= 1 && String(perBox) !== e.savedPerBox) {
      const saved = await quickUnitsPerBoxAction(target.id, perBox);
      if (saved.ok) e.savedPerBox = String(perBox);
      else e.error = saved.error;
    }

    if (fields.includes("cartons") && (e.cartons !== "" || e.singles !== "")) {
      if (e.cartons !== "" && Number(e.cartons) > 0 && !(perBox >= 1)) {
        e.error = "Say how many singles come in a box first.";
        return false;
      }
      const total = (e.cartons === "" ? 0 : Number(e.cartons) * perBox) + (e.singles === "" ? 0 : Number(e.singles));
      if (String(total) !== e.savedCount) {
        const counted = await quickCountAction(target.id, total);
        if (counted.ok) {
          e.savedCount = String(total);
          const delta = Number(counted.data.delta);
          e.note = `Saved ${total} on hand${delta === 0 ? ", no change" : ` (${delta > 0 ? "+" : ""}${delta})`}.`;
        } else {
          e.error = counted.error;
        }
      }
    }
    return e.error === null;
  };

  const goTo = (index: number) => {
    s.index = index;
    const next = variants[index];
    if (next) s.field = startField(entryFor(next));
  };

  const moveVariant = async (step: number) => {
    const { variant } = cur();
    if (!variant) return;
    if (!(await commit(variant))) return redraw();
    const target = s.index + step;
    if (target >= variants.length) {
      clearResume(productId, mode);
      stopMic();
      setDone(true);
      return redraw();
    }
    goTo(Math.max(0, target));
    const now = variants[s.index];
    if (now) writeResume(productId, mode, { variantId: now.id, carried: s.carried });
    redraw();
  };

  const advance = async () => {
    const at = fields.indexOf(s.field);
    if (at < fields.length - 1) {
      s.field = fields[at + 1]!;
      redraw();
    } else {
      await moveVariant(1);
    }
  };

  const back = async () => {
    const at = fields.indexOf(s.field);
    if (at > 0) {
      s.field = fields[at - 1]!;
      redraw();
    } else if (s.index > 0) {
      await moveVariant(-1);
    }
  };

  const close = async () => {
    const { variant } = cur();
    if (variant && !(await commit(variant))) return redraw();
    if (variant) writeResume(productId, mode, { variantId: variant.id, carried: s.carried });
    stopMic();
    onClose();
  };

  const saveCode = async (which: "unit" | "carton") => {
    const { variant, entry } = cur();
    if (!variant || !entry) return;
    const code = (which === "unit" ? entry.unitCode : entry.cartonCode).trim();
    if (!code) return advance();
    entry.error = null;
    const saved = await quickBarcodeAction(variant.id, code, which, Number(entry.perBox));
    if (!saved.ok) {
      entry.error = saved.error;
      // Left in the box and selected, so the next scan replaces it.
      redraw();
      return;
    }
    if (which === "unit") {
      entry.unitSaved = code;
      entry.unitCode = "";
    } else {
      entry.cartonSaved = code;
      entry.cartonCode = "";
    }
    await advance();
  };

  /** Enter in a box: a typed number, an empty box skipped, or a scan finished. */
  const enter = async () => {
    const { entry } = cur();
    if (!entry) return;
    if (isCodeField(s.field)) return saveCode(s.field === "unitCode" ? "unit" : "carton");
    if (s.field === "perBox" && entry.perBox) {
      if (!(Number(entry.perBox) >= 1)) {
        entry.error = "A box holds at least one.";
        return redraw();
      }
      s.carried = entry.perBox;
    }
    await advance();
  };

  const handle = async (command: SpokenCommand) => {
    const { entry } = cur();
    if (!entry) return;
    switch (command.kind) {
      case "number": {
        if (isCodeField(s.field)) {
          entry.error = "Scan the barcode here, or say skip.";
          return redraw();
        }
        entry[s.field as "perBox" | "cartons" | "singles"] = String(command.value);
        return enter();
      }
      case "skip":
        if (s.field === "perBox") entry.perBox = "";
        else if (s.field === "cartons" || s.field === "singles") entry[s.field] = "";
        return advance();
      case "next":
        return moveVariant(1);
      case "previous":
        return moveVariant(-1);
      case "back":
        return back();
      case "boxSize":
        s.field = "perBox";
        return redraw();
      case "close":
        return close();
    }
  };

  // One thing at a time, in the order it was said or scanned. Each task
  // finishes its save before the next one reads the flavor it is on.
  const queue = useRef<(() => Promise<void>)[]>([]);
  const pumping = useRef(false);
  const run = (task: () => Promise<void>) => {
    queue.current.push(task);
    if (pumping.current) return;
    pumping.current = true;
    setBusy(true);
    void (async () => {
      while (queue.current.length > 0) {
        const next = queue.current.shift()!;
        try {
          await next();
        } catch {
          const { entry } = cur();
          if (entry) entry.error = "Something went wrong saving that. Try again.";
          redraw();
        }
      }
      pumping.current = false;
      setBusy(false);
    })();
  };
  // Commands are handled through a ref so a phrase heard mid render still
  // reaches the latest handler.
  const handleRef = useRef(handle);
  handleRef.current = handle;

  // ---------------------------------------------------------------- microphone

  const recognition = useRef<Recognition | null>(null);
  const wantListening = useRef(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [hearing, setHearing] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  /** When recent sessions ended, to tell a normal pause from a loop. */
  const restarts = useRef<number[]>([]);

  function startMic() {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setMicError("This browser can't listen. Open the back office in Chrome or Edge to use the microphone.");
      return;
    }
    // One recognizer at a time. Two fight over the microphone, each start
    // ending the other, and the tab's mic icon blinks without hearing a word.
    const previous = recognition.current;
    recognition.current = null;
    previous?.abort();
    setMicError(null);
    restarts.current = [];
    let lastError = "";
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]!;
        const text = result[0].transcript;
        if (result.isFinal) {
          setHeard(text.trim());
          const commands = parseSpoken(text);
          for (const command of commands) run(() => handleRef.current(command));
        } else {
          interim += text;
        }
      }
      setHearing(interim.trim());
    };
    rec.onerror = (event) => {
      lastError = event.error;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantListening.current = false;
        setMicError(
          "The microphone is blocked. Allow it from the icon in the address bar, then press Start listening. It only works on this computer's own address (localhost).",
        );
      } else if (event.error === "audio-capture") {
        wantListening.current = false;
        setMicError("No microphone was found. Check it is plugged in and chosen as the input in Windows sound settings.");
      } else if (event.error === "network") {
        setMicError("Chrome's speech service can't be reached. Check the internet connection.");
      }
    };
    // Chrome ends a session after a pause; starting it again keeps the
    // microphone open from one flavor to the next. A recognizer that was
    // replaced or stopped stays stopped, and one that keeps ending straight
    // away gives up and says why rather than blinking.
    rec.onend = () => {
      if (recognition.current !== rec) return;
      if (!wantListening.current) {
        setListening(false);
        return;
      }
      const now = Date.now();
      restarts.current = [...restarts.current.filter((t) => now - t < 5000), now];
      if (restarts.current.length > 4) {
        wantListening.current = false;
        setListening(false);
        setMicError(`The microphone keeps stopping${lastError ? ` (${lastError})` : ""}. Press Start listening to try again.`);
        return;
      }
      window.setTimeout(() => {
        if (recognition.current !== rec || !wantListening.current) return;
        try {
          rec.start();
        } catch {
          /* already starting */
        }
      }, 300);
    };
    wantListening.current = true;
    recognition.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setMicError("The microphone could not start. Press Start listening to try again.");
    }
  }

  function stopMic() {
    wantListening.current = false;
    const rec = recognition.current;
    recognition.current = null;
    rec?.stop();
    setListening(false);
    setHearing("");
  }

  // Listening from the moment it opens: the whole point is not to click.
  // Started a beat later so React mounting this twice in development never
  // makes a second recognizer: the first mount's timer is cleared unfired.
  useEffect(() => {
    const timer = window.setTimeout(startMic, 200);
    return () => {
      window.clearTimeout(timer);
      wantListening.current = false;
      const rec = recognition.current;
      recognition.current = null;
      rec?.abort();
    };
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The box being filled always has the cursor, so a scan lands in it.
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  useEffect(() => {
    const input = inputs.current[s.field];
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  });

  // ---------------------------------------------------------------- drawing

  if (done) {
    return (
      <Overlay>
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <p className="text-2xl font-semibold">All {variants.length} flavors done.</p>
          <p className="text-sm text-[var(--color-text-muted)]">
            Counts are on the stock list now. New barcodes and box sizes reach the registers when you Send to POS.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[var(--color-accent)] px-6 py-3 text-base font-medium text-[var(--color-accent-contrast)]"
          >
            Close
          </button>
        </div>
      </Overlay>
    );
  }

  if (!variant || !entry) {
    return (
      <Overlay>
        <p className="py-10 text-center text-sm">This item has no flavors on sale to go through.</p>
        <button type="button" onClick={onClose} className="mx-auto block rounded-md border px-4 py-2 text-sm">
          Close
        </button>
      </Overlay>
    );
  }

  const perBox = Number(entry.perBox);
  const total =
    entry.cartons === "" && entry.singles === ""
      ? null
      : (entry.cartons === "" ? 0 : Number(entry.cartons) * (perBox || 0)) + (entry.singles === "" ? 0 : Number(entry.singles));
  const unitOnFile = (variant.barcodes ?? []).filter((code) => Number(code.units) <= 1).map((code) => code.barcode);
  const boxOnFile = (variant.barcodes ?? []).filter((code) => Number(code.units) > 1).map((code) => code.barcode);
  const carriedFrom = s.carried && entry.perBox === s.carried && s.index > 0;

  const hint: Record<Field, string> = {
    perBox: carriedFrom ? "Same as the flavor before. Change it if this one differs." : "Say how many singles come in one box.",
    cartons: "Say a number, or skip.",
    singles: "Loose singles, not in a full box.",
    unitCode: entry.unitSaved
      ? `Saved ${entry.unitSaved}.`
      : unitOnFile.length > 0
        ? `On file: ${unitOnFile.join(", ")}. Scan to add another, or say skip.`
        : "Scan the single.",
    cartonCode: entry.cartonSaved
      ? `Saved ${entry.cartonSaved}.`
      : boxOnFile.length > 0
        ? `On file: ${boxOnFile.join(", ")}. Scan to add another, or say skip.`
        : `Scan the box. It will ring up ${perBox > 1 ? perBox : "?"} singles.`,
  };

  return (
    <Overlay>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            {MODE_LABEL[mode].start} · {productName}
          </p>
          <h2 className="truncate text-3xl font-semibold">{variant.variant_name ?? variant.sku}</h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            {s.index + 1} of {variants.length}
            {variants[s.index + 1] ? ` · next: ${variants[s.index + 1]!.variant_name ?? variants[s.index + 1]!.sku}` : " · last one"}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(close)}
          className="shrink-0 rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          Save and close
        </button>
      </div>

      <div className={`grid gap-3 ${fields.length > 3 ? "grid-cols-2 md:grid-cols-5" : "grid-cols-3"}`}>
        {fields.map((field) => {
          const active = s.field === field;
          return (
            <label
              key={field}
              className={`flex flex-col gap-1 rounded-lg border p-3 ${
                active
                  ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]"
                  : "border-[var(--color-border)]"
              }`}
            >
              <span className="text-xs text-[var(--color-text-muted)]">{FIELD_LABEL[field]}</span>
              <input
                ref={(el) => {
                  inputs.current[field] = el;
                }}
                value={entry[field]}
                inputMode={isCodeField(field) ? "text" : "numeric"}
                autoComplete="off"
                onFocus={() => {
                  if (s.field !== field) {
                    s.field = field;
                    redraw();
                  }
                }}
                onChange={(e) => {
                  entry[field] = isCodeField(field) ? e.target.value : e.target.value.replace(/[^\d]/g, "");
                  redraw();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    run(enter);
                  }
                }}
                className={`w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 outline-none ${
                  isCodeField(field) ? "font-mono text-lg" : "text-3xl font-semibold tabular-nums"
                }`}
              />
              <span className="min-h-8 text-xs text-[var(--color-text-muted)]">{hint[field]}</span>
            </label>
          );
        })}
      </div>

      {fields.includes("cartons") ? (
        <p className="text-sm">
          {total === null
            ? "Nothing counted for this flavor yet."
            : `${entry.cartons || 0} ${Number(entry.cartons) === 1 ? "box" : "boxes"} × ${perBox || "?"} + ${entry.singles || 0} singles = ${total} on hand.`}
          {entry.note ? <span className="ml-2 text-[var(--color-success)]">{entry.note}</span> : null}
        </p>
      ) : null}

      {entry.error ? <p className="text-sm font-medium text-[var(--color-error)]">{entry.error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || s.index === 0}
          onClick={() => run(() => moveVariant(-1))}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-40"
        >
          ◀ Previous flavor
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => handleRef.current({ kind: "skip" }))}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-40"
        >
          Skip this box
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => moveVariant(1))}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-40"
        >
          Next flavor ▶
        </button>
        <span className="ml-auto text-xs text-[var(--color-text-muted)]">{busy ? "Saving..." : null}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-bg)] p-3 text-sm">
        <button
          type="button"
          onClick={() => (listening ? stopMic() : startMic())}
          className={`rounded-full px-4 py-2 text-sm font-medium ${
            listening ? "bg-[var(--color-error)] text-white" : "border border-[var(--color-border)]"
          }`}
        >
          {listening ? "● Listening" : "🎤 Start listening"}
        </button>
        <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">
          {hearing ? `“${hearing}”` : heard ? `Heard “${heard}”` : "Say a number for the box in blue."}
        </span>
        <span className="w-full text-xs text-[var(--color-text-muted)]">
          Say a number · “skip” · “go back” · “box size” · “next variant” · “previous variant” · “save” or “close”.
          The scanner fills the barcode boxes and moves on by itself.
        </span>
        {micError ? <span className="w-full text-xs text-[var(--color-error)]">{micError}</span> : null}
      </div>
    </Overlay>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 md:p-10">
      <div className="flex w-full max-w-4xl flex-col gap-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
        {children}
      </div>
    </div>
  );
}
