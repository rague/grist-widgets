// Script for a Grist widget using Liquid templating
// This script handles the display of Liquid templates based on Grist data

let options = null; // Widget configuration options
let record = null; // Received record
let data = null; // Current record data
let src = ""; // Liquid template source
let template = undefined; // Compiled template or error
const engine = new liquidjs.Liquid(); // Liquid engine
let cache; // Cache for tables and fields


// Initialize Grist with necessary callbacks
grist.ready({
    onEditOptions: openConfig,
    requiredAccess: 'full', // requires full access to read table data
});


// Callback for multiple record updates (not used here)
grist.onRecords((records, mappings) => {

});


// Callback for single record update
grist.onRecord(async rec => {
    record = rec;
    if (options.templateColumnId === undefined) {
        cache = new CachedTables();
        await openConfig();
    } else {
        await render();
    }

}, { includeColumns: "normal", expandRefs: false, keepEncoded: true });


// Callback for options update
grist.onOptions(async opts => {
    options = opts || {};
})

// Function to render the template in the HTML container
async function render() {
    document.getElementById("print").style.display = "block";
    cache = new CachedTables();
    const tokenInfo = await grist.docApi.getAccessToken({ readOnly: true });
    const tableId = await grist.selectedTable.getTableId();
    const fields = await cache.getFields(tableId);
    const colId = fields.find(t => t.id == options.templateColumnId).colId;
    const newSrc = record[colId]?.tableId ? await getRefTemplate(record[colId].tableId, record[colId].rowId, options.templateRefColumnId) : record[colId];
    data = new RecordDrop(record, fields, tokenInfo);

    if (src !== newSrc) {
        src = newSrc;
        try {
            template = { ok: engine.parse(src) };
        } catch (e) {
            template = { error: e.toString() };
        }
    }

    const container = document.getElementById("container");
    container.innerHTML = template?.ok
        ? await engine.render(template.ok, data)
        : (template?.error ? `<p style="color:red;">Template Error: ${template.error}</p>`
            : "<p>Waiting for data or template</p>");
}


// Function to open the widget configuration
async function openConfig(opts) {
    colId = opts ? opts.colId : options?.templateColumnId;
    document.getElementById("print").style.display = "none";

    const tableId = await grist.selectedTable.getTableId();
    const fields = await cache.getFields(tableId);
    const container = document.getElementById("container");
    const field = colId ? fields.find(t => t.id === colId) : undefined;
    const fieldRef = field?.type.startsWith("Ref") ? field.type.slice(4) : null;
    const refFields = fieldRef ? await cache.getFields(fieldRef) : null;

    container.innerHTML = `<div style="padding: 8px;"` +
        `<p>Please select the template column</p><select id="template-col-id" onchange="selectTemplateColumn()"><option value=""></option>` +
        fields.filter(f => f.type === "Text" || f.type.startsWith("Ref:")).map(col => `<option value="${col.id}" ${col.id === colId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
        `</select>` +
        (refFields ?
            ` <select id="template-ref-col-id"><option value=""></option>` +
            refFields.filter(f => f.type === "Text").map(col => `<option value="${col.id}" ${col.id === options?.templateRefColumnId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
            `</select>`
            : "") +
        `<p><button onclick="openConfig()">Revert</button> ` +
        `<button onclick="validateTemplate()">Ok</button></p></div>`;
}


// Function called when selecting a template column
function selectTemplateColumn() {
    openConfig({ colId: parseInt(document.getElementById("template-col-id").value) });
}

// Function to validate and apply template options
function validateTemplate() {
    const templateColumnId = parseInt(document.getElementById("template-col-id").value);
    let templateRefColumnId = document.getElementById("template-ref-col-id")?.value;
    templateRefColumnId = templateRefColumnId ? parseInt(templateRefColumnId) : null;

    if (!templateColumnId) {
        alert("Please select a column.");
        return;
    }
    if (options.templateColumnId !== templateColumnId || options.templateRefColumnId !== templateRefColumnId) {
        grist.setOptions({
            templateColumnId: templateColumnId,
            templateRefColumnId: templateRefColumnId
        });
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
        this.#tables = grist.docApi.fetchTable('_grist_Tables');
        return this.#tables;
    }


    // Retrieves fields of a table
    async getFields(tableId) {
        if (this.#types[tableId])
            return this.#types[tableId];

        const tables = await this.getTables();
        const columns = await grist.docApi.fetchTable('_grist_Tables_column');
        const tid = tables.id[tables.tableId.indexOf(tableId)];

        const fields = Object.keys(columns);
        const colIndexes = columns.parentId.map((id, i) => [id, i]).filter(item => item[0] === tid).map(item => item[1]);

        this.#types[tableId] = colIndexes.map(index => {
            let t = Object.fromEntries(fields.map(f => [f, columns[f][index]]));
            t.widgetOptions = safeParse(t.widgetOptions);
            return t;
        }).filter(col => col.type !== "ManualSortPos" && !col.colId.startsWith("gristHelper_"));
        return this.#types[tableId];

    }

    // Retrieves data of a table
    async getTable(tableId) {
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
        const refs = {}

        // Defines dynamic properties for each field
        for (const key of Object.keys(record).filter(k => !k.startsWith("gristHelper_"))) {
            let field = fields?.find(f => f.colId === key);
            let type = field?.type?.split(":")[0];
            switch (type) {
                case "Ref":
                    // lookup for reference record, lazily loaded
                    Object.defineProperty(this, key, {
                        get: async function () {
                            if (key in refs) {
                                return refs[key];
                            }

                            if (record[key]?.[0] !== "R") {
                                return "# ERROR_NOT_A_REFERENCE #";
                            }

                            const table = await cache.getTable(record[key][1]);
                            const row = table.find(r => r.id === record[key][2]);
                            if (!row) {
                                return null;
                            }

                            refs[key] = new RecordDrop(row, fields, tokenInfo);
                            return refs[key];
                        },

                    });
                    break;

                case "RefList":
                    const tableId = field?.type?.split(":")[1];

                    Object.defineProperty(this, key, {
                        get: async function () {
                            if (key in refs) {
                                return refs[key];
                            }
                            const table = await cache.getTable(tableId);

                            if (Array.isArray(record[key])) {
                                refs[key] = record[key]?.slice(1)?.map(rowId => {
                                    let row = table.find(r => r.id === rowId);
                                    if (row) {
                                        return new RecordDrop(row, fields, tokenInfo);
                                    } else {
                                        return null;
                                    }
                                });
                            } else {
                                refs[key] = record[key];
                            }
                            return refs[key];
                        },

                    });

                    break;

                case "Date":
                    if (Array.isArray(record[key]) && record[key][0] === "d") {
                        this[key] = new Date(record[key][1] * 1000);
                    } else {
                        this[key] = record[key];
                    }
                    break;

                case "DateTime":
                    if (Array.isArray(record[key]) && record[key][0] === "D") {
                        this[key] = new Date(record[key][1] * 1000);
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
                    break

                default:
                    this[key] = record[key];
                    break
            }
        }
    }
}
