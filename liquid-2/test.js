"use strict";
// =====================================================================
// Tests de régression Node pour liquid-2/script.js
//   Usage :  node test.js        (depuis liquid-2/, ou chemin absolu)
//   Sortie:  0 si tout passe, 1 sinon
//
// Charge le VRAI script.js au-dessus de stubs DOM / liquidjs / grist et
// vérifie le comportement de bout en bout :
// - debounce des callbacks record (leading immédiat, salve coalescée) ;
// - écriture in-place de l'iframe (aucune navigation blob URL) ;
// - refresh arrière-plan du cache hors pipeline, uniquement sur changement
//   réel et seulement hors interaction (REFRESH_IDLE) ;
// - index O(1) de CachedTables (getRow/getRowMap) et refreshData ;
// - garde des règles conditionnelles inconnues dans RecordDrop ;
// - cache du token d'accès (getAccessToken une seule fois).
//
// Durées: calées sur les constantes du widget (debounce 150 ms, timer de
// refresh 3 s, REFRESH_IDLE 5 s) — ne pas réduire les attentes ci-dessous.
// =====================================================================
const fs = require("fs");
const path = require("path");

let failures = 0;
let checks = 0;
function ok(cond, msg) {
    checks++;
    if (cond) console.log("  ✓ " + msg);
    else { failures++; console.log("  ✗ " + msg); }
}
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}
function deepEq(actual, expected, msg) {
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Stubs DOM / librairies ----------
const iframeDoc = {
    written: [],
    open() {},
    write(html) { this.written.push(String(html)); },
    close() {},
    querySelector() { return null; },
};
const widgetWindowStub = {
    scrollY: 10, scrollX: 5,
    scrollTo() {},
    print() {},
};
const containerStub = {
    contentDocument: iframeDoc,
    contentWindow: widgetWindowStub,
    style: {},
    src: "",
    addEventListener() {},
};
const settingsStub = { innerHTML: "", style: {} };
const printBtnStub = { style: {} };

globalThis.document = {
    getElementById(id) {
        if (id === "container") return containerStub;
        if (id === "settings") return settingsStub;
        return printBtnStub;
    },
};
globalThis.window = { addEventListener() {}, open() { return null; } };

globalThis.liquidjs = {
    Drop: class Drop {},
    Liquid: class {
        registerFilter() {}
        parse() { return [{ fake: true }]; }
        async render(tokens, data) {
            // Fait résoudre le getter async du Ref (cache.getTable côté widget)
            const client = data && typeof data.Client !== "undefined" ? await data.Client : null;
            return "R:" + (data ? data.Name : "?") + ":" + (client ? client.City : "none");
        }
    },
};
globalThis.marked = { parse: v => v ?? "" };
globalThis.DOMPurify = { sanitize: v => v };

// ---------- Mock Grist (schéma Factures → Ref/RefList → Clients) ----------
const handlers = {};
let tokenCalls = 0;
const fetchCount = {};

const tablesMeta = {
    id: [1, 2],
    tableId: ["Factures", "Clients"],
    primaryTableId: ["Factures", "Clients"],
};
const columnsMeta = {
    id: [1, 2, 3, 4, 5, 6],
    parentId: [1, 1, 1, 1, 2, 2],
    colId: ["Name", "Client", "Tags", "Template", "City", "Extra"],
    label: ["Name", "Client", "Tags", "Template", "City", "Extra"],
    type: ["Text", "Ref:Clients", "RefList:Clients", "Text", "Text", "Text"],
    widgetOptions: [null, null, null, null, null, null],
    rules: [null, null, null, null, null, null],
};
const clients = [
    { id: 1, City: "Paris", Extra: "a" },
    { id: 2, City: "Lyon", Extra: "b" },
];
const factures = [
    { id: 1, Name: "Ada", Client: 1, Tags: ["L", 1, 2], Template: "t1" },
    { id: 2, Name: "Grace", Client: 2, Tags: ["L", 2], Template: "t2" },
];

function columnar(rows) {
    const cols = {};
    for (const r of rows) {
        for (const [k, v] of Object.entries(r)) (cols[k] ??= []).push(v);
    }
    return cols;
}

globalThis.grist = {
    ready() {},
    onRecords(fn) { handlers.records = fn; },
    onRecord(fn) { handlers.record = fn; },
    onOptions(fn) { handlers.options = fn; },
    setCursorPos() {},
    commandApi: { run() {} },
    selectedTable: { getTableId: async () => "Factures" },
    docApi: {
        async getAccessToken() { tokenCalls++; return { baseUrl: "http://mock", token: "T" }; },
        async fetchTable(tid) {
            fetchCount[tid] = (fetchCount[tid] || 0) + 1;
            if (tid === "Factures") return columnar(factures);
            if (tid === "Clients") return columnar(clients);
            if (tid === "_grist_Tables") return tablesMeta;
            if (tid === "_grist_Tables_column") return columnsMeta;
            return {};
        },
    },
};

// ---------- Chargement du vrai script.js ----------
const src = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
(0, eval)(src + "\n;globalThis.__T = { CachedTables, fieldsIndex, getRefTemplate, refreshCache, RecordDrop, rowsFromRaw, sameRawData, sameRawValue };");

function rec(name, tmpl) {
    return { id: 1, Name: name, Client: 1, Tags: ["L", 1, 2], Template: tmpl ?? "tpl" };
}

(async () => {
    console.log("— options + premier record (leading render immédiat)");
    await handlers.options({ multiple: false, templateColumnId: 4 });
    eq(iframeDoc.written.length, 0, "onOptions sans record ne rend rien");
    handlers.record(rec("Ada"));
    await sleep(80);
    eq(iframeDoc.written.length, 1, "premier onRecord → 1 render immédiat (leading)");
    ok(iframeDoc.written[0].includes("R:Ada:Paris"), "contenu rendu = R:Ada:Paris");
    ok(/^<!doctype html>/i.test(iframeDoc.written[0]), "document écrit in place avec doctype (cleanUpHtml)");
    eq(containerStub.src, "", "aucune navigation d'iframe (pas de blob URL)");
    eq(tokenCalls, 1, "getAccessToken appelé une seule fois (token en cache)");

    console.log("— onRecords en mode single: sans effet sur le rendu");
    await handlers.records([rec("Multi")]);
    eq(iframeDoc.written.length, 1, "onRecords (single) ne déclenche pas de render");

    console.log("— salve de 5 changements de sélection (debounce latest-wins)");
    handlers.record(rec("B"));
    handlers.record(rec("C"));
    handlers.record(rec("D"));
    handlers.record(rec("E"));
    handlers.record(rec("Final"));
    await sleep(250);
    eq(iframeDoc.written.length, 2, "salve de 5 → 1 seul render additionnel (trailing)");
    ok(iframeDoc.written[1].includes("R:Final:Paris"), "état final rendu = R:Final:Paris");

    console.log("— événement isolé (nouveau burst → leading immédiat, trailing sauté)");
    handlers.record(rec("Iso"));
    await sleep(250);
    eq(iframeDoc.written.length, 3, "changement isolé → rendu immédiat");
    ok(iframeDoc.written[2].includes("R:Iso:Paris"), "contenu = R:Iso:Paris");

    console.log("— tick de refresh à 3s: sauté pendant la fenêtre d'activité (REFRESH_IDLE)");
    const clientsFetches = fetchCount["Clients"] || 0;
    const tablesFetches = fetchCount["_grist_Tables"] || 0;
    await sleep(3400); // le tick armé ~3s après le dernier render tombe ICI (< 5s d'activité)
    eq(fetchCount["Clients"] || 0, clientsFetches, "aucun fetch de données au tick < 5s (idle skip)");
    eq(fetchCount["_grist_Tables"] || 0, tablesFetches, "métadonnées non re-fetchées (cache conservé)");
    eq(iframeDoc.written.length, 3, "aucun render au tick < 5s");

    console.log("— refresh en arrière-plan: détection de changement puis re-render");
    clients[0].City = "Nice";
    await sleep(7500);
    eq(iframeDoc.written.length, 4, "donnée référencée modifiée → 1 re-render déclenché");
    ok(iframeDoc.written[3].includes("R:Iso:Nice"), "re-render avec donnée à jour = R:Iso:Nice");
    await sleep(3500);
    eq(iframeDoc.written.length, 4, "donnée inchangée → aucun re-render (fin de la boucle de rechargement)");

    console.log("— comptage des fetchs après le scénario e2e");
    eq(fetchCount["_grist_Tables"] || 0, 1, "_grist_Tables fetché une seule fois (métadonnées en cache)");
    eq(fetchCount["_grist_Tables_column"] || 0, 2, "_grist_Tables_column fetché 2 fois (Factures + Clients)");
    eq(fetchCount["Factures"] || 0, 0, "données de Factures jamais fetchées (template inline)");

    console.log("— CachedTables: getRow/getRowMap (index O(1)) + refreshData");
    const CT = globalThis.__T.CachedTables;
    const ct = new CT();
    const row = await ct.getRow("Clients", 2);
    ok(row && row.City === "Lyon", "getRow('Clients', 2) → Lyon");
    const rowById = await ct.getRow(2, 1); // tableId numérique (_grist_Tables.id)
    ok(rowById && rowById.City === "Nice", "getRow(2, 1) avec tableId numérique → Nice");
    eq(await ct.getRow("Clients", 99), null, "getRow inconnu → null");
    const map = await ct.getRowMap("Clients");
    ok(map instanceof Map && map.get(1).City === "Nice", "getRowMap → Map indexée par rowId");
    clients[0].City = "Rome";
    eq(await ct.refreshData(), true, "refreshData détecte le changement → true");
    eq((await ct.getRow("Clients", 1)).City, "Rome", "cache mis à jour après refreshData");
    eq(await ct.refreshData(), false, "refreshData sans changement → false");
    const ct2 = new CT();
    const [f1, f2] = await Promise.all([ct2.getFields(2), ct2.getFields("Clients")]);
    ok(f1 === f2 && f1.length === 2, "getFields(2)/getFields('Clients') concurrents → même tableau (clé canonique + chargement partagé)");

    console.log("— getRefTemplate via cache.getRow");
    const [tplSrc] = await globalThis.__T.getRefTemplate(1, 1, 4);
    eq(tplSrc, "t1", "getRefTemplate(1, 1, colId 4) → template de la ligne 1");

    console.log("— RecordDrop: règles conditionnelles (garde + calcul)");
    const RD = globalThis.__T.RecordDrop;
    const fieldsOk = [
        { colId: "A", type: "Text", id: 1 },
        { colId: "B", type: "Text", id: 2, rules: [0, 3], widgetOptions: { rulesOptions: [{ fillColor: "#fff" }] } },
        { colId: "C", type: "Text", id: 3 },
    ];
    const dropOk = new RD({ A: "va", B: "vb", C: "1" }, fieldsOk, { baseUrl: "http://x", token: "t" });
    eq(dropOk.B, "vb", "RecordDrop avec règles valides");
    eq(dropOk._.B.conditionalStyles, "background-color: #fff;", "conditionalStyles calculé quand la règle matche");
    const fieldsBad = [
        { colId: "B", type: "Text", id: 2, rules: [0, 999], widgetOptions: { rulesOptions: [{ fillColor: "#fff" }] } },
        { colId: "C", type: "Text", id: 3 },
    ];
    let noCrash = true;
    let dropBad;
    try { dropBad = new RD({ B: "vb", C: "1" }, fieldsBad, { baseUrl: "http://x", token: "t" }); }
    catch (e) { noCrash = false; }
    ok(noCrash && dropBad.B === "vb", "règle inconnue (id 999) → pas de crash (avant: TypeError)");
    eq(dropBad._.B.conditionalStyles, "", "conditionalStyles vide quand aucune règle ne matche");
    eq(globalThis.__T.fieldsIndex(fieldsOk), globalThis.__T.fieldsIndex(fieldsOk), "fieldsIndex indexe une seule fois par tableau (WeakMap)");

    console.log("— helpers purs: rowsFromRaw / sameRawData / sameRawValue");
    const raw = { id: [1, 2], Name: ["A", "B"], Tags: [["L", 1], ["L", 2]] };
    deepEq(globalThis.__T.rowsFromRaw(raw), [{ id: 1, Name: "A", Tags: ["L", 1] }, { id: 2, Name: "B", Tags: ["L", 2] }], "rowsFromRaw: columnar → lignes");
    ok(globalThis.__T.sameRawData(raw, { id: [1, 2], Name: ["A", "B"], Tags: [["L", 1], ["L", 2]] }), "sameRawData: identiques → true");
    ok(!globalThis.__T.sameRawData(raw, { id: [1, 2], Name: ["A", "X"], Tags: [["L", 1], ["L", 2]] }), "sameRawData: valeur changée → false");
    ok(!globalThis.__T.sameRawData(raw, { id: [1, 2], Name: ["A", "B"], Tags: [["L", 1], ["L", 9]] }), "sameRawData: liste changée → false");
    ok(!globalThis.__T.sameRawData(raw, { id: [1, 2, 3], Name: ["A", "B", "C"], Tags: [["L", 1], ["L", 2], ["L", 3]] }), "sameRawData: ligne ajoutée → false");
    ok(!globalThis.__T.sameRawData(raw, { id: [1, 2], Name: ["A", "B"] }), "sameRawData: colonne manquante → false");
    ok(globalThis.__T.sameRawValue(1, 1) && globalThis.__T.sameRawValue(null, null), "sameRawValue: primitives");
    ok(globalThis.__T.sameRawValue(["L", 1, ["x"]], ["L", 1, ["x"]]), "sameRawValue: tableaux imbriqués");
    ok(!globalThis.__T.sameRawValue(["L", 1], ["L", 2]), "sameRawValue: différence détectée");
    ok(!globalThis.__T.sameRawValue(["L", 1], "L"), "sameRawValue: types différents → false");

    console.log(`\n${checks} vérifications, ${failures} échec(s)`);
    console.log(failures === 0 ? "TOUS LES TESTS PASSENT" : "ÉCHECS");
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("ERREUR HARNAIS:", e); process.exit(2); });



