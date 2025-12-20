// Script for a Grist widget Liquid editor using Ace editor
(function () {
    // Variables for managing the editor state
    let colMapping = null; // Column mapping for the code field
    let currentRecord = null; // Current record being edited
    let lastWrite = null; // Last written value to avoid unnecessary updates
    let editor = null; // Ace editor instance

    // Initialize Grist with required access and column definition
    grist.ready({
        requiredAccess: 'full',
        columns: [
            { name: 'code', title: 'Code', type: 'Text', strictType: true },
        ]
    });

    // Callback for new record creation
    grist.onNewRecord(() => {
        if (!editor) {
            buildEditor();
        }

        currentRecord = null;
        editor.setOptions({ readOnly: true });
        editor.session.off('change', commitChangesDebounced);
        editor.session.setValue("");
        editor.session.on('change', commitChangesDebounced);
    });

    // Callback for record updates
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
        editor.setOptions({ readOnly: false });
        editor.session.off('change', commitChangesDebounced);
        editor.session.setValue(record[colMapping.code]);
        editor.session.on('change', commitChangesDebounced);
    });

    // Function to initialize the Ace editor
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
    }

    // Function to check if dark mode is preferred
    function preferDarkMode() {
        return document.getElementsByTagName("html")?.[0]?.dataset.gristAppearance === "dark";
    }

    // Function to commit changes to the record
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

    // Debounced version of commitChanges
    const commitChangesDebounced = () => debounce(commitChanges, 500)();
})();

// Utility function for debouncing
function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}
