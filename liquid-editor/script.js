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
        editor.session.setValue(stripChecksum(record[colMapping.code]));
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
        let checksum = toHex(new Uint8Array(await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(lastWrite))));
        lastWrite = `<!-- checksum:${checksum} -->\n` + lastWrite;
        idx++;
        if (lastWrite === currentRecord[colMapping.code]) {
            return;
        }
        await grist.getTable().update({ id: currentRecord.id, fields: { [colMapping.code]: lastWrite } });
    }

    const commitChangesDebounced = debounce(commitChanges, 300);



})();

let idx = 1

function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

function stripChecksum(str) {
    return str.replace(/<!-- checksum:[\s\S]*? -->\n/g, "");
}

function toHex(toEncode) {
    return [...toEncode].map(byte => byte.toString(16).padStart(2, "0")).join("");
};