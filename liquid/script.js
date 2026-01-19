// Script for a Grist widget using Liquid templating
// This script handles the display of Liquid templates based on Grist data

let options = null; // Widget configuration options
let record = null; // Received record
let records = null; // Received records
let src = ""; // Liquid template source
let previousHtml = ""; // Previous rendered html
let template = undefined; // Compiled template or error
let cache; // Cache for tables and fields
let refreshTimer; // Timer for refresh at regular interval
let tokenInfo; // Access token
const engine = new liquidjs.Liquid({
    outputEscape: "escape",
    jsTruthy: true,
}); // Liquid engine
let multiple = false;


// Initialize Grist with necessary callbacks
grist.ready({
    onEditOptions: openConfig,
    requiredAccess: 'full', // requires full access to read table data
});


// Callback for multiple record updates
grist.onRecords(async (recs, mappings) => {
    records = recs;
    if (multiple) {
        if (options.templateTableId === undefined) {
            cache = new CachedTables();
            await openConfig();
        } else {
            await render();
        }
    }
}, { includeColumns: "all", expandRefs: false, keepEncoded: true });


// Callback for single record update
grist.onRecord(async rec => {
    record = rec;
    if (!multiple) {
        if (options.templateColumnId === undefined) {
            cache = new CachedTables();
            await openConfig();
        } else {
            await render();
        }
    }
}, { includeColumns: "normal", expandRefs: false, keepEncoded: true });


// Callback for options update
grist.onOptions(async opts => {
    options = opts || {};
    multiple = options.multiple;
    if (!multiple && options.templateColumnId === undefined
        || multiple && options.templateTableId === undefined
    ) {
        cache = new CachedTables();
        await openConfig();
    } else if (record || records) {
        await render();
    }
})

// Function to render the template in the HTML container
async function render() {
    document.getElementById("print").style.display = "block";
    cache = new CachedTables();
    tokenInfo = tokenInfo || await grist.docApi.getAccessToken({ readOnly: true });

    const tableId = await grist.selectedTable.getTableId();
    const fields = await cache.getFields(tableId);
    const colId = multiple ? null : fields.find(t => t.id == options.templateColumnId).colId;
    const newSrc = multiple ?
        await getRefTemplate(options.templateTableId, options.templateId, options.templateColumnId)
        : (Array.isArray(record[colId]) && record[colId][0] === "R"
            ? await getRefTemplate(record[colId][1], record[colId][2], options.templateRefColumnId)
            : record[colId]);
    const data = multiple
        ? new RecordDrop({ records: records.map(rec => new RecordDrop(rec, fields, tokenInfo)) }, fields, tokenInfo)
        : new RecordDrop(record, fields, tokenInfo);

    if (src !== newSrc) {
        src = newSrc;
        try {
            template = { ok: engine.parse(src) };
        } catch (e) {
            template = { error: e.toString() };
        }
    }

    const container = document.getElementById("container");
    const html = template?.ok
        ? await engine.render(template.ok, data)
        : (template?.error ? `<p style="color:red;">Template Error: ${template.error}</p>`
            : "<p>Waiting for data or template</p>");

    if (html !== previousHtml) {
        container.innerHTML = html;
    }

    previousHtml = html;

    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(render, 3000);
}


// Function to open the widget configuration
async function openConfig(opts) {
    clearTimeout(refreshTimer);
    previousHtml = "";
    let colId = opts ? opts.colId : options?.templateColumnId;
    let labelId = opts ? opts.labelId : options?.templateLabelColumnId;
    document.getElementById("print").style.display = "none";
    const container = document.getElementById("container");
    const multipleConfig = opts && "multiple" in opts ? opts.multiple : multiple;


    const tableId = multipleConfig
        ? opts?.tid || options.templateTableId
        : await grist.selectedTable.getTableId();

    const tables = multipleConfig ? await cache.getTables() : null;

    let out = `<div style="padding: 8px;"><fieldset><legend>Mode :</legend>
  <div>
    <input type="radio" id="single" name="mode" value="single" onclick="setMultiple(false)" ${multipleConfig ? "" : "checked"} />
    <label for="single">Single record</label>

    <input type="radio" id="multiple" name="mode" value="multiple" onclick="setMultiple(true)" ${multipleConfig ? "checked" : ""}/>
    <label for="multiple">Record list</label>
  </div>
</fieldset><fieldset><legend>Template</legend>`;
    let cond = null;

    if (multipleConfig) {
        out += `<p>Table: <select id="template-table-id" onchange="selectTemplatesTable()"><option value=""></option>` +
            Object.values(tables).map(table => `<option value="${table.id}" ${table.id === tableId ? "selected" : ""}>${table.tableId}</option>`).join("<br/>") +
            `</select></p>`;
    }


    if (!multipleConfig || tableId) {
        const fields = await cache.getFields(multipleConfig ? tables[tableId].tableId : tableId);
        const field = colId ? fields.find(t => t.id === colId) : undefined;



        out += `<p>Column: <select id="template-col-id" onchange="selectTemplateColumn(${multipleConfig}, ${multipleConfig ? tableId : null})"><option value=""></option>` +
            fields.filter(f => f.type === "Text" || (multipleConfig ? false : f.type.startsWith("Ref:"))).map(col => `<option value="${col.id}" ${col.id === colId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
            `</select><p>`;

        if (multipleConfig) {
            out += `<p>Label: <select id="template-label-id" onchange="selectLabelColumn(${tableId}, ${colId})"><option value=""></option>` +
                fields.filter(f => f.type === "Text" && f.id !== colId).map(col => `<option value="${col.id}" ${col.id === labelId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
                `</select><p>`
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
                templateTableId: tableId,
                templateColumnId: colId,
                isRef: refFields ? true : false
            }
        }

        if (multipleConfig && colId && labelId) {
            const records = await cache.getTable(tables[tableId].tableId);
            const field = fields.find(f => f.id === labelId).colId;
            out += `<p>Template: <select id="template-id" onchange=""><option value=""></option>` +
                records.map(rec => `<option value="${rec.id}" ${rec.id === options?.templateId ? "selected" : ""}>${rec[field]}</option>`).join("<br/>") +
                `</select></p>`;
            cond = {
                multiple: multipleConfig,
                templateTableId: tableId,
                templateColumnId: colId,
                templateLabelColumnId: labelId
            };
        }


    }

    out += `</fieldset><p><button onclick="openConfig()">Revert</button> ` +
        `<button id="config-ok" ${cond ? "" : "disabled"}>Ok</button></p></div>`;
    container.innerHTML = out;
    document.getElementById("config-ok").onclick = () => validateTemplate(cond);
}

function setMultiple(bool) {
    openConfig({ multiple: bool });
}

// Function called when selecting a template column
function selectTemplatesTable() {
    openConfig({ multiple: true, tid: parseInt(document.getElementById("template-table-id").value) });
}
// Function called when selecting a template column
function selectTemplateColumn(multiple, tid) {
    openConfig({ multiple, tid, colId: parseInt(document.getElementById("template-col-id").value) });
}
// Function called when selecting a label column
function selectLabelColumn(tid, colId) {
    openConfig({ multiple: true, tid, colId, labelId: parseInt(document.getElementById("template-label-id").value) });
}

// Function to validate and apply template options
function validateTemplate(opts) {
    if (opts.multiple) {
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
                multiple: true,
                templateTableId: opts.templateTableId,
                templateColumnId: opts.templateColumnId,
                templateLabelColumnId: opts.templateLabelColumnId,
                templateId: templateId
            });
            return;

        }
    } else {
        const templateRefColumnId = opts.isRef ? parseInt(document.getElementById("template-ref-col-id")?.value) : null;
        if (!opts.templateColumnId || (opts.isRef && !templateRefColumnId)) {
            alert("Please select a column.");
            return;
        }
        if (options.templateColumnId !== opts.templateColumnId || options.templateRefColumnId !== templateRefColumnId) {
            grist.setOptions({
                multiple: false,
                templateColumnId: opts.templateColumnId,
                templateRefColumnId: templateRefColumnId
            });
            return;
        }
    }

    render();
}

// Function to retrieve template from a reference
async function getRefTemplate(tableId, rowId, templateRefColumnId) {
    const fields = await cache.getFields(tableId);
    const colId = fields.find(t => t.id === templateRefColumnId).colId;
    const table = await cache.getTable(tableId, true);
    const src = table.find(r => r.id === rowId)[colId];
    return src;
}



// Class to cache Grist tables and fields
class CachedTables {
    #tables = null;
    #types = {};
    #tablesData = {};

    constructor() {
    }

    // Retrieves the list of tables
    async getTables() {
        if (this.#tables)
            return this.#tables;
        const raw = await grist.docApi.fetchTable('_grist_Tables');
        this.#tables = Object.fromEntries(raw.id.map((id, i) =>
            [id, Object.fromEntries(Object.keys(raw).map(k => [k, raw[k][i]]))]
        ));
        return this.#tables;
    }


    // Retrieves fields of a table
    async getFields(tableId) {
        if (this.#types[tableId])
            return this.#types[tableId];

        let tid = tableId;
        if (typeof tableId === "string") {
            const tables = await this.getTables();
            tid = Object.values(tables).find(table => table.tableId === tableId).id;
        }
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

    // Retrieves data of a table
    async getTable(tableId) {
        if (typeof tableId === "number") {
            const tables = await this.getTables();
            tableId = tables[tableId].tableId;
        }

        if (this.#tablesData[tableId])
            return this.#tablesData[tableId];



        const table = await grist.docApi.fetchTable(tableId);
        const fields = Object.keys(table);
        this.#tablesData[tableId] = table.id.map((_, i) => {
            let row = Object.fromEntries(fields.map(f => [f, table[f][i]]));
            return row;
        });
        return this.#tablesData[tableId];
    }
}

// Utility function to parse JSON safely
function safeParse(value) {
    try {
        return JSON.parse(value);
    } catch (err) {
        return null;
    }
}


// Class to represent a record as a Liquid Drop object
class RecordDrop extends liquidjs.Drop {
    constructor(record, fields, tokenInfo) {
        super();

        if (fields) {
            this._ = Object.fromEntries(fields.map(f => {
                const opts = f.widgetOptions;
                if (opts) {
                    opts.styles = stylesFromOptions(opts);
                    opts.headerStyles = headerStylesFromOptions(opts);
                }
                return [f.colId, opts]
            }));
        } else {
            this._ = {};
        }

        for (const key of Object.keys(record).filter(k => !k.startsWith("gristHelper_"))) {
            let field = fields?.find(f => f.colId === key);
            let type = field?.type?.split(":")[0];
            let rules;
            if (field) {
                rules = field.rules?.slice(1).map(cid => fields.find(f => f.id === cid)).map(f => record[f.colId]);
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
                        this[key] = record[key]?.slice(1).map(c => new ValueDrop(c, field?.widgetOptions?.choiceOptions?.[c]), rules);
                    } else {
                        this[key] = record[key];
                    }
                    break;

                case "Choice":
                    this[key] = new ValueDrop(record[key], field?.widgetOptions?.choiceOptions?.[record[key]], rules);
                    break;

                default:
                    any(this, key, record[key], tokenInfo, field?.widgetOptions, rules)
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


class ValueDrop extends liquidjs.Drop {
    constructor(value, options, rules) {
        super();
        this.value = value;
        this._ = { ...options };

        if (options) {
            this._.styles = stylesFromOptions(options);
            this._.headerStyles = headerStylesFromOptions(options);
            if (rules) {
                this._.conditionalStyles = options.rulesOptions?.filter((_, idx) => rules[idx]).map(ropt => stylesFromOptions(ropt)).join();
            }
        }
    }
    valueOf() {
        return this.value;
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

function any(o, key, data, tokenInfo, options, rules) {
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
        o[key] = new ValueDrop(data, options, rules);
    }
}

function refGetter(tableId, rowId) {
    let ref;
    return async function () {

        if (ref) {
            return ref;
        }

        const table = await cache.getTable(tableId);
        const fields = await cache.getFields(tableId);
        const row = table.find(r => r.id === rowId);
        if (!row) {
            return null;
        }

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
        const table = await cache.getTable(tableId);
        const fields = await cache.getFields(tableId);

        refList = ids.map(rowId => {
            let row = table.find(r => r.id === rowId);
            if (row) {
                return new RecordDrop(row, fields, tokenInfo);
            } else {
                return null;
            }
        });

        return refList;
    }
}