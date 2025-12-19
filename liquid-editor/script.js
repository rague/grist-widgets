(function () {
    let colMapping = null;
    let currentRecord = null;
    let lastWrite = null;
    let editor = null;

    grist.ready({
        requiredAccess: 'full',
        columns: [
            { name: 'code', title: 'Code', type: 'Text', strictType: true },
        ]
    });

    grist.onRecord(async (record, mapping) => {
        if (!mapping) return;
        if (!editor) {
            buildEditor();
        }
        colMapping = mapping;
        if (record.id === currentRecord?.id && record[colMapping.code] === lastWrite) {
            currentRecord = record;
            return;
        }

        currentRecord = record;
        editor.session.setValue(record[colMapping.code]);
    });

    function buildEditor() {
        if (editor) {
            return;
        }
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
        editor.session.on('change', function () {
            commitChangesDebounced();
        });
    }

    function preferDarkMode() {
        return document.getElementsByTagName("html")?.[0]?.dataset.gristAppearance === "dark";
    }

    async function commitChanges() {
        if (!currentRecord) {
            return;
        }
        lastWrite = editor.getValue();
        if (lastWrite === currentRecord[colMapping.code]) {
            return;
        }
        await grist.getTable().update({ id: currentRecord.id, fields: { [colMapping.code]: lastWrite } });
    }

    const commitChangesDebounced = debounce(commitChanges, 300);



})();

function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}
