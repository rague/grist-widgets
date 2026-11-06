// Script for a Grist widget using Liquid templating (V2)
// This script handles the display of Liquid templates based on Grist data
//
// V2 vs V1: record fields are exposed as RAW values (no ValueDrop wrapper), so
// value-oriented filters (map, uniq, json, sort...) work natively.
// Display options live at the record level under _:
//   _.<colId>.styles / _.<colId>.headerStyles   field-level styles
//   _.<colId>.choiceOptions[<value>].styles     per-choice styles
//   _.<colId>.conditionalStyles                 styles of rules matching this record
// BREAKING vs V1: <field>.value and <field>._ are gone - use _.<colId>... instead.
//
// Performance notes:
// - record callbacks are debounced with an immediate leading call: a burst of
//   selection changes renders once right away, then once when the burst settles
//   ("latest wins"), instead of queuing one render per 200ms tick;
// - rendering writes the iframe document in place (no blob URL navigation);
// - cached table data is refreshed in the background every 3s, OUTSIDE the
//   serialized render pipeline, and only triggers a re-render when some data
//   actually changed (schema metadata stays cached).

let options = null; // Widget configuration options
let record = null; // Received record
let records = null; // Received records
let src = ""; // Liquid template source
let previousHtml = ""; // Previous rendered html
let template = undefined; // Compiled template or error
let cache; // Cache for tables and fields
let refreshTimer; // Timer for the periodic background cache refresh
let refreshingCache = false; // Guards against overlapping background refreshes
let tokenInfo; // AccessTokenResult (token, baseUrl, ttlMsecs)
let tokenExpiresAt = 0; // Moment the current access token stops being usable
// Fallback when the server does not report a lifetime (ttlMsecs): tokens
// expire after ~5 minutes server-side, refresh earlier than that.
const TOKEN_TTL_FALLBACK = 4 * 60 * 1000;
let lastActivity = 0; // Moment of the last received record event
// Skip the background cache refresh while record events arrived recently (the
// user is actively changing the selection): never slow down interactions.
const REFRESH_IDLE = 5000;
const engine = new liquidjs.Liquid({
    // outputEscape: "escape",
    jsTruthy: true,
}); // Liquid engine
let multiple = false;
const container = document.getElementById("container");
const settings = document.getElementById("settings");
const widgetWindow = container.contentWindow;


let lastScrollY;
let lastScrollX;
container.addEventListener("load", () => {
    widgetWindow.scrollTo(lastScrollX, lastScrollY);
});


engine.registerFilter('markdown', v => DOMPurify.sanitize(marked.parse(v ?? "")));


grist.ready({
    onEditOptions: openConfig,
    requiredAccess: 'full',
    allowSelectBy: true
});

window.addEventListener('message', async (event) => {
    // Security: Validate origin
    if (event.source !== widgetWindow) return;
    switch (event.data.command) {
        case "select":
            grist.setCursorPos({ rowId: event.data.rowId });
            break;
        case "openCard":
            await grist.setCursorPos({ rowId: event.data.rowId });
            grist.commandApi.run('viewAsCard');
            break;
    }
});

// Callback for multiple record updates.
// Debounced with an immediate leading call (see debounce): the first event
// renders right away and a rapid burst of updates is coalesced ("latest wins")
// into a single trailing render, so changing the selection quickly no longer
// piles up a queue of serialized renders.
grist.onRecords(debounce(async (recs, mappings) => {
    lastActivity = Date.now();
    records = recs;
    if (multiple) {
        if (options.templateTableId === undefined) {
            cache = new CachedTables();
            await openConfig();
        } else {
            await render();
        }
    }
}, 150), { includeColumns: "all", expandRefs: false, keepEncoded: true });


// Callback for single record update (same debouncing as onRecords)
grist.onRecord(debounce(async rec => {
    lastActivity = Date.now();
    record = rec;
    if (!multiple) {
        if (options.templateColumnId === undefined) {
            cache = new CachedTables();
            await openConfig();
        } else {
            await render();
        }
    }
}, 150), { includeColumns: "normal", expandRefs: false, keepEncoded: true });


// Callback for options update
grist.onOptions(async opts => {
    options = opts || {};
    multiple = options.multiple;

    if ((multiple || options.templateFromOther) && options.templateTableId === undefined || !(multiple || options.templateFromOther) && options.templateColumnId === undefined

    ) {
        cache = new CachedTables();
        await openConfig();
    } else if (record || records) {
        await render();
    }
})

// Function to render the template in the HTML container.
// Serialized: an older async render can no longer overwrite a newer one,
// and a render requested during an in-flight render is re-queued.
let renderPending = false;
let renderQueued = false;
async function render() {
    if (renderPending) { renderQueued = true; return; }
    renderPending = true;
    try {
        await doRender();
    } finally {
        renderPending = false;
        if (renderQueued) { renderQueued = false; render(); }
    }
}

// Returns a valid AccessTokenResult (token, baseUrl, ttlMsecs), transparently
// refreshing it before the expiry reported by the server in ttlMsecs (cf
// AccessTokenResult docs; previously the first token was kept forever). 10% of
// the reported lifetime are subtracted to absorb clock skew; a fallback
// applies when ttlMsecs is missing (older Grist versions).
async function getToken() {
    if (!tokenInfo || Date.now() >= tokenExpiresAt) {
        const result = await grist.docApi.getAccessToken({ readOnly: true });
        const ttl = typeof result?.ttlMsecs === "number" && result.ttlMsecs > 0
            ? result.ttlMsecs
            : TOKEN_TTL_FALLBACK;
        tokenInfo = result;
        tokenExpiresAt = Date.now() + Math.floor(ttl * 0.9);
    }
    return tokenInfo;
}

async function doRender() {
    const templateFromOther = options.templateFromOther || multiple;

    document.getElementById("print").style.display = "block";
    cache = cache ? cache : new CachedTables();
    await getToken(); // Cached, transparently refreshed before server-side expiry

    const tableId = await grist.selectedTable.getTableId();
    const fields = await cache.getFields(tableId);
    const colId = templateFromOther ? null : fields.find(t => t.id == options.templateColumnId).colId;
    const [newSrc, templateRecord] = templateFromOther ?
        await getRefTemplate(options.templateTableId, options.templateId, options.templateColumnId)
        : (Array.isArray(record[colId]) && record[colId][0] === "R"
            ? await getRefTemplate(record[colId][1], record[colId][2], options.templateRefColumnId)
            : [record[colId], null]);
    const data = multiple
        ? new RecordDrop({ records: records.map(rec => new RecordDrop(rec, fields, tokenInfo)) }, fields, tokenInfo)
        : new RecordDrop(record, fields, tokenInfo);

    if (templateRecord) {
        data._template = new RecordDrop(templateRecord, await cache.getFields(templateFromOther ? options.templateTableId : record[colId][1]), tokenInfo)
    }


    if (src !== newSrc) {
        src = newSrc;
        try {
            template = { ok: engine.parse(src) };
        } catch (e) {
            template = { error: e.toString() };
        }
    }


    const html = template?.ok
        ? await engine.render(template.ok, data)
        : (template?.error ? `<p style="color:red;">Template Error: ${template.error}</p>`
            : "<p>Waiting for data or template</p>");

    if (html !== previousHtml) {
        lastScrollY = widgetWindow.scrollY;
        lastScrollX = widgetWindow.scrollX;

        // Write the new document in place instead of navigating the iframe to a
        // new blob URL: same parsing and script semantics (same origin), but no
        // navigation, which is much cheaper when updates arrive in bursts. The
        // scroll is restored right away; the "load" handler also covers browsers
        // that fire a load event after write/close.
        const doc = container.contentDocument;
        doc.open();
        doc.write(cleanUpHtml(html));
        doc.close();
        widgetWindow.scrollTo(lastScrollX, lastScrollY);

        container.style.display = "";
        settings.innerHTML = "";
    }

    previousHtml = html;

    scheduleRefresh();
}

// Re-arms the periodic background refresh of cached table data.
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshCache, 3000);
}

// Periodic refresh of the cached data of the tables used by the template
// (referenced tables, template table). Deliberately kept OUT of the serialized
// render() pipeline so it can never delay a selection-driven render:
// - skipped while a render is pending/queued or the user is actively selecting;
// - only table data is refreshed, schema metadata stays cached;
// - updated rows are swapped into the cache (no full cache wipe anymore) and a
//   re-render is triggered only when some data actually changed.
async function refreshCache() {
    scheduleRefresh();
    if (refreshingCache || renderPending || renderQueued || !cache) return;
    if (Date.now() - lastActivity < REFRESH_IDLE) return;
    refreshingCache = true;
    try {
        if (await cache.refreshData()) {
            await render();
        }
    } catch (e) {
        // Network or token error: keep the cached data, retry at the next cycle.
        console.warn("Background cache refresh failed:", e);
    } finally {
        refreshingCache = false;
    }
}

function cleanUpHtml(input) {
    const body = (s) => /^<body[\s>]/i.test(s) ? s : `<body>${s}</body>`;
    const head = (s) => /^<head[\s>]/i.test(s) ? s : `<head><meta charset="utf-8"></head>${body(s)}`;
    const html = (s) => /^<html[\s>]/i.test(s) ? s : `<html>${head(s)}</html>`;
    const doctype = (s) => /^<!doctype/i.test(s) ? s : `<!doctype html>\n${html(s)}`;
    return doctype(input.trimStart());
}

// Function to open the widget configuration
async function openConfig(opts) {

    clearTimeout(refreshTimer);
    previousHtml = "";
    let colId = opts && "colId" in opts ? opts.colId : options?.templateColumnId;
    let labelId = opts && "labelId" in opts ? opts.labelId : options?.templateLabelColumnId;
    let other = opts && "templateFromOther" in opts ? opts.templateFromOther : options?.templateFromOther;
    document.getElementById("print").style.display = "none";
    const multipleConfig = opts && "multiple" in opts ? opts.multiple : multiple;
    const otherTable = other || multipleConfig;


    const tableId = otherTable ?
        opts?.tid || options?.templateTableId
        : await grist.selectedTable.getTableId();

    const tables = otherTable ? await cache.getTables() : null;

    const handlers = {};
    let out = `<div style="padding: 8px;"><fieldset><legend>Mode</legend>
  <div>
    <input type="radio" id="single" name="mode" value="single" onclick="setMultiple(false)" ${multipleConfig ? "" : "checked"} />
    <label for="single">Single record</label>

    <input type="radio" id="multiple" name="mode" value="multiple" onclick="setMultiple(true)" ${multipleConfig ? "checked" : ""}/>
    <label for="multiple">Record list</label>
  </div>
</fieldset>`

    if (!multipleConfig) {
        out += `<fieldset><legend>Get template from:</legend>
            <p>
                <span><input type="radio" id="tplcol" name="tplsrc" ${other ? "" : "checked"} /><label for="tplcol">Column</label></span>
                <span><input type="radio" id="tpltbl" name="tplsrc" ${other ? "checked" : ""} /><label for="tpltbl">Other table</label></span>
            </p></fieldset>`;

        handlers["tplcol"] = ["click", () => setOther(opts, false)];
        handlers["tpltbl"] = ["click", () => setOther(opts, true)];
    }

    out += `<fieldset><legend>Template</legend>`;
    let cond = null;

    if (otherTable) {
        out += `<p>Table: <select id="template-table-id"><option value=""></option>` +
            Object.values(tables).map(table => `<option value="${table.id}" ${table.id === tableId ? "selected" : ""}>${table.tableId}</option>`).join("<br/>") +
            `</select></p>`;
        handlers["template-table-id"] = ["change", () => selectTemplatesTable(opts)];

    }

    if (!otherTable || tableId) {
        const fields = await cache.getFields(otherTable ? tables[tableId].tableId : tableId);
        const field = colId ? fields.find(t => t.id === colId) : undefined;


        out += `<p>Column: <select id="template-col-id"><option value=""></option>` +
            fields.filter(f => f.type === "Text" || (otherTable ? false : f.type.startsWith("Ref:"))).map(col => `<option value="${col.id}" ${col.id === colId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
            `</select><p>`;

        handlers["template-col-id"] = ["change", () => selectTemplateColumn(opts, otherTable ? tableId : null)];

        if (otherTable) {
            out += `<p>Label: <select id="template-label-id"><option value=""></option>` +
                fields.filter(f => f.type === "Text" && f.id !== colId).map(col => `<option value="${col.id}" ${col.id === labelId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
                `</select><p>`
            handlers["template-label-id"] = ["change", () => selectLabelColumn(opts, tableId, colId)];

        } else {
            const fieldRef = field?.type.startsWith("Ref") ? field.type.slice(4) : null;
            const refFields = fieldRef ? await cache.getFields(fieldRef) : null;
            out += (refFields ?
                `<p>Code: <select id="template-ref-col-id"><option value=""></option>` +
                refFields.filter(f => f.type === "Text").map(col => `<option value="${col.id}" ${col.id === options?.templateRefColumnId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
                `</select><p>`
                : "")
            cond = {
                multiple: multipleConfig,
                templateFromOther: other,
                templateTableId: tableId,
                templateColumnId: colId,
                isRef: refFields ? true : false
            }
        }

        if (otherTable && colId && labelId) {
            const records = await cache.getTable(tables[tableId].tableId);
            const field = fields.find(f => f.id === labelId).colId;
            out += `<p>Template: <select id="template-id"><option value=""></option>` +
                records.map(rec => `<option value="${rec.id}" ${rec.id === options?.templateId ? "selected" : ""}>${rec[field]}</option>`).join("<br/>") +
                `</select></p>`;
            cond = {
                multiple: multipleConfig,
                templateFromOther: other,
                templateTableId: tableId,
                templateColumnId: colId,
                templateLabelColumnId: labelId
            };
        }
    }

    out += `</fieldset>`;
    out += `<p><button onclick="openConfig()">Revert</button> ` +
        `<button id="config-ok" ${cond ? "" : "disabled"}>Ok</button></p></div>`;
    settings.innerHTML = out;
    container.style.display = "none";
    for (const [id, [event, handler]] of Object.entries(handlers)) {
        document.getElementById(id).addEventListener(event, handler);
    }
    document.getElementById("config-ok").onclick = () => validateTemplate(cond);
}

function setMultiple(bool) {
    openConfig({ multiple: bool });
}

function setOther(opts, bool) {
    openConfig({ ...opts, templateFromOther: bool });
}

// Function called when selecting a template column
function selectTemplatesTable(opts) {
    openConfig({ ...opts, tid: parseInt(document.getElementById("template-table-id").value) });
}
// Function called when selecting a template column
function selectTemplateColumn(opts, tid) {
    openConfig({ ...opts, tid, colId: parseInt(document.getElementById("template-col-id").value) });
}
// Function called when selecting a label column
function selectLabelColumn(opts, tid, colId) {
    openConfig({ ...opts, tid, colId, labelId: parseInt(document.getElementById("template-label-id").value) });
}


// Function to validate and apply template options
function validateTemplate(opts) {
    if (opts.multiple || opts.templateFromOther) {
        const templateId = parseInt(document.getElementById("template-id")?.value);
        if (!templateId) {
            alert("Please select a template.");
            return;
        }
        if (options.templateTableId !== opts.templateTableId
            || options.templateColumnId !== opts.templateColumnId
            || options.templateLabelColumnId !== opts.templateLabelColumnId
            || options.templateId !== templateId) {
            grist.setOptions({
                multiple: opts.multiple,
                templateFromOther: opts.templateFromOther,
                templateTableId: opts.templateTableId,
                templateColumnId: opts.templateColumnId,
                templateLabelColumnId: opts.templateLabelColumnId,
                templateId: templateId,
            });


        }
    } else {
        const templateRefColumnId = opts.isRef ? parseInt(document.getElementById("template-ref-col-id")?.value) : null;
        if (!opts.templateColumnId || (opts.isRef && !templateRefColumnId)) {
            alert("Please select a column.");
            return;
        }
        if (options.templateColumnId !== opts.templateColumnId
            || options.templateRefColumnId !== templateRefColumnId) {
            grist.setOptions({
                multiple: false,
                templateColumnId: opts.templateColumnId,
                templateRefColumnId: templateRefColumnId,
            });
        }
    }

    render();
}

// Function to retrieve template from a reference
async function getRefTemplate(tableId, rowId, templateRefColumnId) {
    const fields = await cache.getFields(tableId);
    const colId = fields.find(t => t.id === templateRefColumnId).colId;
    const template = await cache.getRow(tableId, rowId);
    return [template ? template[colId] : undefined, template];
}

// Class to cache Grist tables and fields
class CachedTables {
    #tables = null; // Table metadata (_grist_Tables)
    #tablesLoad = null; // In-flight tables metadata load
    #types = {}; // tableId -> fields metadata (_grist_Tables_column)
    #fieldsLoads = {}; // tableId -> in-flight fields load
    #tablesData = {}; // tableId -> array of row objects
    #rawData = {}; // tableId -> raw columnar data, kept for change detection
    #rowsById = {}; // tableId -> Map(rowId -> row object)
    #dataLoads = {}; // tableId -> in-flight data load

    constructor() {
    }

    // Retrieves the list of tables. Concurrent calls share the in-flight load,
    // so the metadata is fetched exactly once even when accessed in parallel.
    async getTables() {
        if (this.#tables)
            return this.#tables;
        if (!this.#tablesLoad) {
            this.#tablesLoad = grist.docApi.fetchTable('_grist_Tables')
                .then(raw => {
                    this.#tables = Object.fromEntries(raw.id.map((id, i) =>
                        [id, Object.fromEntries(Object.keys(raw).map(k => [k, raw[k][i]]))]
                    ));
                    return this.#tables;
                })
                .catch(e => { this.#tablesLoad = null; throw e; });
        }
        return this.#tablesLoad;
    }


    // Retrieves fields of a table. The cache key is the canonical tableId
    // string, so a numeric table row id and its string tableId share the same
    // cache entry (and columns are fetched once per table).
    async getFields(tableId) {
        tableId = await this.#resolveTableId(tableId);
        if (this.#types[tableId])
            return this.#types[tableId];
        if (!this.#fieldsLoads[tableId]) {
            this.#fieldsLoads[tableId] = this.#loadFields(tableId)
                .catch(e => { delete this.#fieldsLoads[tableId]; throw e; });
        }
        return this.#fieldsLoads[tableId];
    }

    async #loadFields(tableId) {
        const tables = await this.getTables();
        const tid = Object.values(tables).find(table => table.tableId === tableId).id;
        const columns = await grist.docApi.fetchTable('_grist_Tables_column');
        const fields = Object.keys(columns);
        const colIndexes = columns.parentId.map((id, i) => [id, i]).filter(item => item[0] === tid).map(item => item[1]);

        this.#types[tableId] = colIndexes.map(index => {
            let t = Object.fromEntries(fields.map(f => [f, columns[f][index]]));
            t.widgetOptions = safeParse(t.widgetOptions);
            return t;
        });
        return this.#types[tableId];
    }

    // Retrieves data of a table as an array of row objects. Concurrent calls
    // share the in-flight load.
    async getTable(tableId) {
        tableId = await this.#resolveTableId(tableId);

        if (this.#tablesData[tableId])
            return this.#tablesData[tableId];

        if (!this.#dataLoads[tableId]) {
            this.#dataLoads[tableId] = this.#loadTable(tableId)
                .catch(e => { delete this.#dataLoads[tableId]; throw e; });
        }
        return this.#dataLoads[tableId];
    }

    async #loadTable(tableId) {
        const raw = await grist.docApi.fetchTable(tableId);
        this.#rawData[tableId] = raw;
        this.#tablesData[tableId] = rowsFromRaw(raw);
        this.#rowsById[tableId] = new Map(this.#tablesData[tableId].map(row => [row.id, row]));
        return this.#tablesData[tableId];
    }

    // Resolves a numeric table row id (as used in Ref values) to its tableId
    async #resolveTableId(tableId) {
        if (typeof tableId === "number") {
            const tables = await this.getTables();
            tableId = tables[tableId].tableId;
        }
        return tableId;
    }

    // Retrieves a Map(rowId -> row object) for O(1) lookups by id
    async getRowMap(tableId) {
        tableId = await this.#resolveTableId(tableId);
        await this.getTable(tableId);
        return this.#rowsById[tableId];
    }

    // Retrieves a single row by id (O(1) lookup instead of a linear scan)
    async getRow(tableId, rowId) {
        const rowMap = await this.getRowMap(tableId);
        return rowMap.get(rowId) ?? null;
    }

    // Background refresh of the data of all cached tables. Schema metadata is
    // intentionally not refreshed (it is stable); each cached table is
    // re-fetched and swapped in only when its content actually changed.
    // Returns true if at least one table changed.
    async refreshData() {
        let changed = false;
        for (const tableId of Object.keys(this.#rawData)) {
            const raw = await grist.docApi.fetchTable(tableId);
            if (sameRawData(this.#rawData[tableId], raw)) continue;
            this.#rawData[tableId] = raw;
            this.#tablesData[tableId] = rowsFromRaw(raw);
            this.#rowsById[tableId] = new Map(this.#tablesData[tableId].map(row => [row.id, row]));
            changed = true;
        }
        return changed;
    }
}

// Converts a raw columnar fetchTable result into an array of row objects
function rowsFromRaw(table) {
    const fields = Object.keys(table);
    return table.id.map((_, i) => {
        let row = Object.fromEntries(fields.map(f => [f, table[f][i]]));
        return row;
    });
}

// Compares two raw columnar fetchTable results to detect actual changes
function sameRawData(a, b) {
    const cols = Object.keys(a);
    if (cols.length !== Object.keys(b).length) return false;
    for (const col of cols) {
        const ca = a[col];
        const cb = b[col];
        if (!Array.isArray(ca) || !Array.isArray(cb) || ca.length !== cb.length) return false;
        for (let i = 0; i < ca.length; i++) {
            if (!sameRawValue(ca[i], cb[i])) return false;
        }
    }
    return true;
}

// Values are primitives or nested arrays of primitives (lists)
function sameRawValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => sameRawValue(v, b[i]));
    }
    return false;
}

// Utility function to parse JSON safely
function safeParse(value) {
    try {
        return JSON.parse(value);
    } catch (err) {
        return null;
    }
}


// Indexes a fields array (from CachedTables.getFields) by colId and by rule id.
// The index is cached per array instance (WeakMap): the same array is shared by
// all the RecordDrops of a render, so it is built once per table instead of
// doing an O(C) scan per column of every record (O(C²) per record before).
const fieldsIndexCache = new WeakMap();
function fieldsIndex(fields) {
    if (!fields) return null;
    let index = fieldsIndexCache.get(fields);
    if (!index) {
        index = {
            byColId: new Map(fields.map(f => [f.colId, f])),
            byId: new Map(fields.map(f => [f.id, f])),
        };
        fieldsIndexCache.set(fields, index);
    }
    return index;
}

// Class to represent a record as a Liquid Drop object
class RecordDrop extends liquidjs.Drop {
    constructor(record, fields, tokenInfo) {
        super();

        const index = fieldsIndex(fields);
        const fieldByColId = index?.byColId;
        const fieldById = index?.byId;

        if (fields) {
            this._ = Object.fromEntries(fields.map(f => {
                const opts = f.widgetOptions;
                if (opts) {
                    opts.styles = stylesFromOptions(opts);
                    opts.headerStyles = headerStylesFromOptions(opts);
                    for (const co of Object.values(opts.choiceOptions ?? {})) {
                        if (co && typeof co === "object") { co.styles = stylesFromOptions(co); }
                    }
                }
                return [f.colId, opts]
            }));
        } else {
            this._ = {};
        }

        for (const key of Object.keys(record).filter(k => !k.startsWith("gristHelper_"))) {
            let field = fieldByColId?.get(key);
            let type = field?.type?.split(":")[0];
            let rules;
            if (field) {
                rules = field.rules?.slice(1).map(cid => fieldById.get(cid)).map(f => f ? record[f.colId] : null);
                // V2: styles of the rules matching this record
                const co = this._[key];
                if (co) { co.conditionalStyles = co.rulesOptions?.filter((_, idx) => rules?.[idx]).map(r => stylesFromOptions(r)).join(); }
            }
            switch (type) {
                case "Ref":
                    // lookup for reference , lazily loaded
                    if (Array.isArray(record[key]) && record[key][0] == "R") {

                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, {
                            get: refGetter(tableId, record[key][2], tokenInfo)
                        });

                    } else if (typeof record[key] === "number") {
                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, {
                            get: refGetter(tableId, record[key], tokenInfo)
                        });
                    } else {
                        this[key] = record[key];
                    }
                    break;

                case "RefList":
                    // lookup for references list, lazily loaded
                    if (Array.isArray(record[key]) && record[key][0] == "L") {
                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, {
                            get: refListGetter(tableId, record[key]?.slice(1), tokenInfo)
                        });
                    } else if (typeof record[key] === "number") {
                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, {
                            get: refListGetter(tableId, record[key], tokenInfo)
                        });
                    } else {
                        this[key] = record[key];
                    }
                    break;

                case "Attachments":
                    if (Array.isArray(record[key])) {
                        this[key] = record[key]?.slice(1).map(id => {
                            return `${tokenInfo.baseUrl}/attachments/${id}/download?auth=${tokenInfo.token}`;
                        });
                    } else {
                        this[key] = record[key];
                    }
                    break;

                case "ChoiceList":
                    if (Array.isArray(record[key])) {
                        this[key] = record[key]?.slice(1);
                    } else {
                        this[key] = record[key];
                    }
                    break;

                case "Choice":
                    this[key] = record[key];
                    break;

                default:
                    any(this, key, record[key], tokenInfo)
            }
        }
    }
}

// Class to represent a dict as a Liquid Drop object
class DictDrop extends liquidjs.Drop {
    constructor(dict, tokenInfo) {
        super();
        // Defines dynamic properties for each field
        for (const key of Object.keys(dict).filter(k => !k.startsWith("gristHelper_"))) {
            any(this, key, dict[key], tokenInfo);
        }
    }
}


function stylesFromOptions(options) {
    return (options.alignment ? `text-align: ${options.alignment};` : "") +
        (options.textColor ? `color: ${options.textColor};` : "") +
        (options.fillColor ? `background-color: ${options.fillColor};` : "") +
        (options.fontBold ? `font-weight: bold;` : "") +
        (options.fontUnderline ? `text-decoration: underline;` : "") +
        (options.fontItalic ? `font-style: italic;` : "") +
        (options.fontStrikethrough ? `text-decoration-line: line-through;` : "")
}

function headerStylesFromOptions(options) {
    return (options.headerAlignment ? `text-align: ${options.headerAlignment};` : "") +
        (options.headerTextColor ? `color: ${options.headerTextColor};` : "") +
        (options.headerFillColor ? `background-color: ${options.headerFillColor};` : "") +
        (options.headerFontBold ? `font-weight: bold;` : "") +
        (options.headerFontUnderline ? `text-decoration: underline;` : "") +
        (options.headerFontItalic ? `font-style: italic;` : "") +
        (options.headerFontStrikethrough ? `text-decoration-line: line-through;` : "")
}

function any(o, key, data, tokenInfo) {
    if (Array.isArray(data)) {
        switch (data[0]) {
            case 'L':
                o[key] = data?.slice(1);
                break;
            case 'O':
                o[key] = new DictDrop(data[1], tokenInfo);
                break;
            case 'D':
                o[key] = new Date(data[1] * 1000);
                break;
            case 'd':
                o[key] = new Date(data[1] * 1000);
                break;
            case 'R':
                Object.defineProperty(o, key, {
                    get: refGetter(data[1], data[2])
                });
                break;
            case 'r':
                Object.defineProperty(o, key, {
                    get: refListGetter(data[1], data[2], tokenInfo)
                });
                break;
            default:
                o[key] = data;
        }

    } else {
        o[key] = data;
    }
}

function refGetter(tableId, rowId) {
    let ref;
    return async function () {

        if (ref) {
            return ref;
        }

        const row = await cache.getRow(tableId, rowId);
        if (!row) {
            return null;
        }
        const fields = await cache.getFields(tableId);

        ref = new RecordDrop(row, fields, tokenInfo);

        return ref;
    };
}

function refListGetter(tableId, ids, tokenInfo) {
    let refList;
    return async function () {
        if (refList) {
            return refList;
        }
        const rowMap = await cache.getRowMap(tableId);
        const fields = await cache.getFields(tableId);

        refList = ids.map(rowId => {
            let row = rowMap.get(rowId);
            if (row) {
                return new RecordDrop(row, fields, tokenInfo);
            } else {
                return null;
            }
        });

        return refList;
    }
}

// Debounce with an immediate leading call: the first event of a burst runs
// right away, then events arriving during the quiet period are coalesced
// ("latest wins") into a single trailing call once the burst settles. A rapid
// burst of selection changes therefore triggers one render up front and one
// final render, instead of one render every `delay` ms. An isolated event
// triggers only the leading call (nothing new arrived to coalesce).
function debounce(fn, delay) {
    let timer = null;
    let pendingArgs = null;
    let pendingThis = null;
    let hasPending = false;
    let leading = true; // Next isolated event starts a new burst
    const run = () => {
        hasPending = false;
        return fn.apply(pendingThis, pendingArgs)
            ?.catch(e => console.warn("Record callback failed:", e));
    };
    return function (...args) {
        pendingThis = this;
        pendingArgs = args;
        hasPending = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (leading) {
            // Leading edge: run immediately
            leading = false;
            run();
        }
        timer = setTimeout(() => {
            timer = null;
            leading = true;
            // Trailing edge: run only if new events were coalesced during the
            // quiet period (never with empty args after a leading-only burst)
            if (hasPending) {
                run();
                pendingArgs = null;
                pendingThis = null;
            }
        }, delay);
    };
}

function print() {
    // If the rendered html provides a <title>, use the grist-cw-html-to-pdf
    // technique: render it in a new window before printing. Browsers use the
    // document title as the default file name when saving as PDF, which does
    // not work when printing directly from an iframe. Otherwise, print the
    // iframe directly, as before.
    const title = container.contentDocument?.querySelector("title")?.textContent?.trim();
    if (!title) {
        container.contentWindow.print();
        return;
    }

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
        // Popup blocked: fall back to printing the iframe
        console.warn("Print popup blocked by the browser: the <title> tag will not be used as the PDF file name.");
        container.contentWindow.print();
        return;
    }

    // Load the rendered html in the new window through a blob url, exactly
    // like doRender does for the iframe (no document.write), then auto-print
    // once loaded (same technique as grist-cw-html-to-pdf), so the print
    // dialog proposes the title as the default PDF file name. window.print()
    // being blocking, the blob url is revoked right after the dialog closes.
    const autoPrint = `<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); URL.revokeObjectURL(location.href); window.close();}, 250); });<\/script>`;
    const html = cleanUpHtml(previousHtml);
    const fullHtml = /<\/body>/i.test(html)
        ? html.replace(/<\/body>/i, `${autoPrint}</body>`)
        : html + autoPrint;
    printWindow.location.href = URL.createObjectURL(new Blob([fullHtml], { type: "text/html" }));
}