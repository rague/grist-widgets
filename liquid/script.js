let options = null;
let data = null;
let src = "";
let checksum = null;
let template = undefined;
const engine = new liquidjs.Liquid();
let cache;


grist.ready({
    onEditOptions: openConfig,
    requiredAccess: 'full', // requires full access to read table data
});


grist.onRecords((records, mappings) => {

});

// Placeholder for reacting to a single record update.
grist.onRecord(async record => {
    if (options?.templateColumnId === undefined) {
        return;
    }
    cache = new CachedTables();
    const tableId = await grist.selectedTable.getTableId();
    const fields = await cache.getFields(tableId);
    const colId = fields.find(t => t.id == options.templateColumnId).colId;
    const newSrc = record[colId]?.tableId ? await getRefTemplate(record[colId].tableId, record[colId].rowId, options.templateRefColumnId) : record[colId];
    const newChecksum = newSrc.split("\n")?.[0]?.match(/<!-- checksum:([\s\S])*? -->/g);
    data = new RecordDrop(record);


    if (newChecksum?.[1] && newChecksum[1] !== checksum || src !== newSrc) {
        checksum = newChecksum?.[1];
        src = newSrc;
        try {
            template = { ok: engine.parse(src) };
        } catch (e) {
            template = { error: e.toString() };
        }
    }

    await render();
}, { includeColumns: "normal", expandRefs: false });


grist.onOptions(async opts => {
    options = opts || {};
    if (options.templateColumnId === undefined) {
        new CachedTables();
        await openConfig();
    } else {
        await render();
    }
})

async function getRefTemplate(tableId, rowId, templateRefColumnId) {
    const fields = await cache.getFields(tableId);
    const colId = fields.find(t => t.id === templateRefColumnId).colId;
    const table = await cache.getTable(tableId, true);
    const src = table.find(r => r.id === rowId)[colId];
    return src;
}

async function render() {
    // Rendering logic goes here
    const container = document.getElementById("container");
    container.innerHTML = template?.ok
        ? await engine.render(template.ok, data)
        : (template?.error ? `<p style="color:red;">Template Error: ${template.error}</p>`
            : "<p>Waiting for data or template</p>");
}

async function openConfig(opts) {
    colId = opts ? opts.colId : options?.templateColumnId;

    const tableId = await grist.selectedTable.getTableId();
    const fields = await cache.getFields(tableId);
    const container = document.getElementById("container");
    const field = colId ? fields.find(t => t.id === colId) : undefined;
    const fieldRef = field?.type.startsWith("Ref") ? field.type.slice(4) : null;
    const refFields = fieldRef ? await cache.getFields(fieldRef) : null;

    container.innerHTML = `<div class="options">` +
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



function selectTemplateColumn() {
    openConfig({ colId: parseInt(document.getElementById("template-col-id").value) });
}

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


class CachedTables {
    #tables = null;
    #types = {};
    #tablesData = {};

    constructor() {
    }

    async getTables() {
        if (this.#tables)
            return this.#tables;
        this.#tables = grist.docApi.fetchTable('_grist_Tables');
        return this.#tables;
    }


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
        console.log("COLUMNS TYPES:", this.#types[tableId]);
        return this.#types[tableId];
    }

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

function safeParse(value) {
    try {
        return JSON.parse(value);
    } catch (err) {
        return null;
    }
}

class RecordDrop extends liquidjs.Drop {
    #record;
    #refs = {};
    constructor(record) {
        super();
        this.#record = record;
        for (const key of Object.keys(record).filter(k => !k.startsWith("gristHelper_"))) {
            if (record[key]?.constructor?.name !== "Reference") {
                this[key] = record[key];
            } else {
                Object.defineProperty(this, key, {
                    get: async function () {
                        if (this.#refs[key]) {
                            return this.#refs[key];
                        }
                        const ref = this.#record[key];

                        if (ref?.constructor?.name !== "Reference") {
                            return "# ERROR_NOT_A_REFERENCE #";
                        }

                        const table = await cache.getTable(ref.tableId);
                        const row = table.find(r => r.id === ref.rowId);
                        if (!row) {
                            return null;
                        }

                        this.#refs[key] = new RecordDrop(row);
                        return this.#refs[key];
                    },

                });
            }
        }
    }
}
