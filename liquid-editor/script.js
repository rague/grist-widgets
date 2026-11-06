// Script for a Grist widget "Liquid editor" using Ace editor.
//
// Anti-data-loss design (see the "éditeur de texte dans Grist" write-up):
// onRecord re-delivers the WHOLE row on ANY change (echoes of our own writes,
// triggers on other columns, concurrent edits, selection changes). The rules
// applied here:
//  1. Every write is bound to the target captured at keystroke time
//     ({ recordId, colId, value }); timers never read the module globals.
//  2. Pending saves are flushed on transitions: record switch, deselection /
//     unmapping, new record, pagehide and visibilitychange.
//  3. onRecord never rebuilds the editor while keystrokes are pending or a
//     write is in flight (a retroactive echo would wipe the typing).
//  4. Echoes are recognized by state (lastSavedValue / lastTypedValue), not
//     by the screen; robust if a trigger normalizes the column.
//  5. A null/undefined cell loads as "" (never "null", never a crash).
//  6. The debounce has a max-wait: continuous typing still saves periodically.
//  7. Bursts of onRecord callbacks are coalesced (immediate leading call,
//     then "latest wins" trailing call).
//  8. A failed write keeps the value pending and retries on the next trigger
//     (keystroke, record switch, page close); a status chip shows the state.

(function () {
    "use strict";

    // --- Tuning ------------------------------------------------------------
    const DEBOUNCE_MS = 500;  // Quiet period after the last keystroke
    const MAX_WAIT_MS = 3000; // Hard cap: typing continuously still saves
    const BURST_MS = 250;     // Coalescing window for onRecord bursts

    // --- State -------------------------------------------------------------
    let editor = null;          // Ace editor instance
    let currentRecordId = null; // Row currently shown (null: none/new record)
    let currentColId = null;    // Mapped column currently edited
    let lastSavedValue = null;  // Value known to be held by Grist for this row
    let lastTypedValue = null;  // Value currently shown in the editor
    const pendingSaves = new Map(); // recordId -> { recordId, colId, value }
    let inFlight = 0;           // Number of writes currently in flight
    let debounceTimer = null;
    let maxWaitTimer = null;

    grist.ready({
        requiredAccess: 'full',
        columns: [
            { name: 'code', title: 'Code', type: 'Text', strictType: true },
        ]
    });

    // onRecord fires for ANY change on the row (echoes, other-column triggers,
    // concurrent edits...): coalesce bursts instead of rebuilding per callback.
    const applyRecordDebounced = debounce(applyRecord, BURST_MS);

    grist.onNewRecord(onNewRecord);
    grist.onRecord(onRecordCallback);

    // Best-effort flush when the widget is closed or hidden: the iframe may
    // be destroyed right after, so the pending saves leave NOW. They carry
    // their own captured target, so this can never write to the wrong row.
    window.addEventListener("pagehide", flushPendingSaves);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushPendingSaves();
    });

    // --- Grist events --------------------------------------------------------

    // "+" new record: there is no row id to write to yet. Flush what was
    // typed for the previous row BEFORE blanking the editor, then lock until
    // a real record arrives through onRecord.
    function onNewRecord() {
        if (!editor) buildEditor();
        flushPendingSaves();
        currentRecordId = null;
        currentColId = null;
        lastSavedValue = null;
        lastTypedValue = null;
        editor.setOptions({ readOnly: true });
        setEditorValue("");
        setStatus("newrec");
    }

    function onRecordCallback(record, mapping) {
        if (!editor) buildEditor();
        applyRecordDebounced(record, mapping);
    }

    function applyRecord(record, mapping) {
        if (!record || record.id == null || !mapping || !mapping.code) {
            // Deselection or unmapping: flush what was typed, then lock.
            flushPendingSaves();
            currentRecordId = null;
            currentColId = null;
            lastSavedValue = null;
            lastTypedValue = null;
            editor.setOptions({ readOnly: true });
            setEditorValue("");
            setStatus("locked");
            return;
        }
        const colId = mapping.code;
        const recordId = record.id;
        const serverValue = normalize(record[colId]);

        if (recordId !== currentRecordId) {
            // Row switch: flush the previous row's typing FIRST. The pending
            // save carries its own captured target, so it always lands on the
            // row the keystroke was made on, never on the freshly loaded one.
            flushPendingSaves();
            currentRecordId = recordId;
            currentColId = colId;
            lastSavedValue = serverValue;
            lastTypedValue = serverValue;
            editor.setOptions({ readOnly: false });
            setEditorValue(serverValue);
            setStatus("loaded");
            return;
        }
        // Same row, but the mapped column changed (re-mapping): reload from
        // the new column. Flush first: pending saves keep their own column.
        if (colId !== currentColId) {
            flushPendingSaves();
            currentColId = colId;
            lastSavedValue = serverValue;
            lastTypedValue = serverValue;
            setEditorValue(serverValue);
            setStatus("loaded");
            return;
        }
        // Same row and column. NEVER rebuild while a keystroke is pending or
        // a write is in flight: onRecord is retroactive (echoes of our own
        // writes, triggers on other columns). Ignore and let the save flow.
        if (pendingSaves.size > 0 || inFlight > 0) {
            return;
        }
        // Recognize echoes by state, not by the screen: the value matches what
        // we last wrote or what is currently typed -> nothing to apply.
        if (serverValue === lastSavedValue || serverValue === lastTypedValue) {
            lastSavedValue = serverValue;
            return;
        }
        // Genuine remote change with nothing in flight: apply it.
        lastSavedValue = serverValue;
        lastTypedValue = serverValue;
        setEditorValue(serverValue);
        setStatus("loaded");
    }

    // --- Saving ---------------------------------------------------------------

    function onEditorChange() {
        // Locked (no record / new record): keystrokes cannot happen anyway.
        if (currentRecordId == null || !currentColId) return;
        const value = normalize(editor.getValue());
        lastTypedValue = value;
        // Capture the target NOW (rule 1): if the row changes while the
        // debounce is armed, the timer still writes to THIS row and column.
        pendingSaves.set(currentRecordId, { recordId: currentRecordId, colId: currentColId, value });
        // Max-wait (rule 6): a debounce re-armed at every keystroke would
        // never fire while the user keeps typing.
        if (!maxWaitTimer) maxWaitTimer = setTimeout(flushPendingSaves, MAX_WAIT_MS);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flushPendingSaves, DEBOUNCE_MS);
        setStatus("typing");
    }

    function flushPendingSaves() {
        clearSaveTimers();
        if (pendingSaves.size === 0) return;
        const saves = Array.from(pendingSaves.values());
        pendingSaves.clear();
        for (const save of saves) doSave(save);
    }

    function doSave(save) {
        if (!save || save.recordId == null || !save.colId) return;
        // No-op write (typed back to the stored value): drop it. A value
        // kept pending after a FAILURE never matches lastSavedValue, so it
        // always gets its retry.
        if (save.value === lastSavedValue && save.recordId === currentRecordId) {
            setStatusIfIdle();
            return;
        }
        inFlight++;
        setStatus("saving");
        Promise.resolve()
            .then(() => targetTable().update({ id: save.recordId, fields: { [save.colId]: save.value } }))
            .then(() => {
                inFlight--;
                // The server now holds this value: later echoes of it must be
                // recognized even if a trigger normalized the column. Only
                // refresh the state of the row still on screen.
                if (save.recordId === currentRecordId) lastSavedValue = save.value;
                setStatusIfIdle();
            })
            .catch((err) => {
                inFlight--;
                console.warn("Liquid editor: write failed, value kept for retry", err);
                // Never silently drop (rule 8): retry on the next trigger
                // (keystroke, record switch, page close). A more recent
                // pending value for the same row wins (latest wins).
                if (!pendingSaves.has(save.recordId)) pendingSaves.set(save.recordId, save);
                setStatus("error");
            });
    }

    function setStatusIfIdle() {
        if (inFlight === 0 && pendingSaves.size === 0 && currentRecordId != null) {
            setStatus("saved");
        }
    }

    function targetTable() {
        // grist.selectedTable is the native write path (Access Rules aware);
        // fall back to getTable() for older plugin API versions.
        return (grist.selectedTable && typeof grist.selectedTable.update === "function")
            ? grist.selectedTable
            : grist.getTable();
    }

    function setEditorValue(value) {
        editor.session.off("change", onEditorChange);
        editor.session.setValue(normalize(value));
        editor.session.on("change", onEditorChange);
    }

    function normalize(value) {
        return value == null ? "" : String(value);
    }

    function clearSaveTimers() {
        clearTimeout(debounceTimer);
        clearTimeout(maxWaitTimer);
        debounceTimer = maxWaitTimer = null;
    }

    // --- Status chip ----------------------------------------------------------

    const STATUS = {
        locked: { text: "Verrouillé", bg: "#90a4ae" },
        newrec: { text: "Nouvelle ligne", bg: "#90a4ae" },
        loaded: { text: "Prêt", bg: "#78909c" },
        typing: { text: "Non enregistré", bg: "#ff9800" },
        saving: { text: "Enregistrement…", bg: "#ff9800" },
        saved: { text: "Enregistré ✓", bg: "#43a047" },
        error: { text: "Échec — réessai à la prochaine action", bg: "#e53935" },
    };
    let statusChip = null;

    function setStatus(kind) {
        const info = STATUS[kind] || STATUS.loaded;
        if (!statusChip) {
            if (!document.body) return;
            statusChip = document.createElement("div");
            statusChip.id = "liquid-editor-status";
            Object.assign(statusChip.style, {
                position: "fixed",
                right: "8px",
                bottom: "8px",
                padding: "2px 8px",
                borderRadius: "10px",
                fontSize: "11px",
                lineHeight: "16px",
                color: "#fff",
                pointerEvents: "none",
                zIndex: 10,
            });
            document.body.appendChild(statusChip);
        }
        statusChip.style.background = info.bg;
        statusChip.textContent = info.text;
        statusChip.title = info.text;
    }

    // --- Editor -----------------------------------------------------------------

    function buildEditor() {
        if (editor) return;
        editor = ace.edit("editor", {
            mode: "ace/mode/liquid",
            selectionStyle: "text",
            theme: preferDarkMode() ? "ace/theme/vibrant_ink" : "ace/theme/sqlserver",
            useSoftTabs: true,
            displayIndentGuides: true,
            highlightIndentGuides: true,
            tabSize: 2,
            keyboardHandler: "ace/keyboard/vscode"
        });
        editor.session.on("change", onEditorChange);
    }

    function preferDarkMode() {
        return document.getElementsByTagName("html")?.[0]?.dataset.gristAppearance === "dark";
    }

    // Debounce with an immediate leading call, then "latest wins" trailing
    // call (same pattern as liquid-2): the first event of a burst applies
    // right away, a burst settles with a single call carrying the LAST state.
    function debounce(fn, delay) {
        let timer = null;
        let pendingArgs = null;
        let hasPending = false;
        let leading = true; // Next isolated event starts a new burst
        const run = () => {
            hasPending = false;
            const args = pendingArgs;
            pendingArgs = null;
            fn(...args);
        };
        return function (...args) {
            pendingArgs = args;
            hasPending = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (leading) {
                leading = false;
                run();
            }
            timer = setTimeout(() => {
                timer = null;
                leading = true;
                if (hasPending) run();
            }, delay);
        };
    }
})();

