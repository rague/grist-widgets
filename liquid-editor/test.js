"use strict";
// =====================================================================
// Tests de régression Node pour liquid-editor/script.js
//   Usage :  node test.js        (depuis liquid-editor/, ou chemin absolu)
//   Sortie:  0 si tout passe, 1 sinon
//
// Charge le VRAI script.js au-dessus de stubs Ace / Grist / DOM et rejoue
// les scénarios critiques de la checklist anti-perte de données :
// - changement de ligne dans la fenêtre de debounce → écriture dans la
//   ligne d'origine (cible capturée à la frappe) ;
// - onRecord rétroactif (trigger sur autre colonne) pendant la frappe →
//   éditeur intact ;
// - écriture en vol + écho rétroactif → aucune reconstruction ;
// - écho de nos propres sauvegardes → pas de reconstruction ;
// - désélection / dé-mapping / onNewRecord → flush des frappes en attente ;
// - pagehide / visibilitychange → flush de secours ;
// - max-wait du debounce (frappe continue) ;
// - échec d'écriture → valeur retenue, re-tentative au déclencheur suivant ;
// - cellule null → "" (jamais "null", jamais de crash) ;
// - salves d'onRecord → coalescées (dernier état gagné).
//
// Durées : calées sur les constantes du widget (debounce 500 ms, max-wait
// 3 s, burst 250 ms) — ne pas réduire les attentes ci-dessous.
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
const MAPPING = { code: "code" }; // mapping délivré par Grist pour la colonne
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Laisse retomber une salve d'onRecord (> BURST_MS 250 ms) pour que chaque
// scénario démarre sur un état stable et une salve fraîche (leading immédiat).
const settle = () => sleep(300);

// ---------- État serveur simulé + journal des écritures ----------
const serverRows = new Map(); // id -> { id, code }
const writes = [];            // chaque appel table.update : { id, fields, failed }
let failNext = 0;             // nombre de prochaines écritures à faire échouer
let updateLatencyMs = 0;      // latence simulée de table.update

const tableApi = {
    async update({ id, fields }) {
        if (updateLatencyMs > 0) await sleep(updateLatencyMs);
        const failed = failNext > 0;
        if (failed) failNext--;
        writes.push({ id, fields, failed });
        if (failed) throw new Error("Access rules denied (simulated)");
        serverRows.set(id, { ...serverRows.get(id), id, ...fields });
    },
};

// ---------- Stubs Grist ----------
const recordHandlers = [];
const newRecordHandlers = [];
let readyOptions = null;
globalThis.grist = {
    ready(opts) { readyOptions = opts; },
    onRecord(fn) { recordHandlers.push(fn); },
    onNewRecord(fn) { newRecordHandlers.push(fn); },
    selectedTable: tableApi, // chemin natif (Access Rules) utilisé par le widget
    getTable: () => tableApi,
};
function emitRecord(rec, mapping) { for (const fn of recordHandlers) fn(rec, mapping); }
function emitNewRecord() { for (const fn of newRecordHandlers) fn(); }

// ---------- Stub Ace ----------
// session.setValue n'est appelé que par le WIDGET (chargement / reconstruction
// distante) : les frappes du test passent par type(), jamais par setValue.
let programmaticSets = 0;
let readOnlyNow;
let editorValue = "";
const changeListeners = new Set();
const aceSession = {
    on(name, fn) { if (name === "change") changeListeners.add(fn); },
    off(name, fn) { changeListeners.delete(fn); },
    getValue: () => editorValue,
    setValue(v) { programmaticSets++; editorValue = String(v); },
};
const aceEditor = {
    session: aceSession,
    getValue: () => editorValue,
    setOptions(o) { readOnlyNow = !!o.readOnly; },
};
globalThis.ace = { edit: () => aceEditor };

// Simuler une frappe utilisateur (passe par les listeners, PAS par setValue)
function type(text) {
    editorValue = String(text);
    for (const fn of Array.from(changeListeners)) fn();
}

// ---------- Stubs DOM / window ----------
let chip = null; // pastille de statut créée par le widget
const docListeners = {};
globalThis.document = {
    visibilityState: "visible",
    body: { appendChild(el) { chip = el; } },
    createElement: () => ({ style: {}, textContent: "", title: "" }),
    addEventListener(name, fn) { docListeners[name] = fn; },
    getElementsByTagName: () => [{ dataset: {} }],
};
const winListeners = {};
globalThis.window = { addEventListener(name, fn) { winListeners[name] = fn; } };
function firePagehide() { for (const fn of Object.values(winListeners)) fn(); }
function fireVisibility(hidden) {
    globalThis.document.visibilityState = hidden ? "hidden" : "visible";
    if (docListeners.visibilitychange) docListeners.visibilitychange();
}

// ---------- Chargement du vrai script.js ----------
const src = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
(0, eval)(src);

// Marqueurs pour comparer des deltas entre avant/après un scénario
let markWrites = 0;
let markSets = 0;
function mark() { markWrites = writes.length; markSets = programmaticSets; }
const newWrites = () => writes.slice(markWrites);
const newSets = () => programmaticSets - markSets;

async function main() {
    eq(readyOptions && readyOptions.requiredAccess, "full", "requiredAccess: 'full' (widget éditeur)");
    eq(readyOptions.columns[0].name, "code", "colonne déclarée: code");

    // --- S1: chargement, frappe, debounce, écho reconnu sans reconstruction ---
    console.log("— S1: chargement + sauvegarde debounce + écho reconnu");
    serverRows.set(1, { id: 1, code: "A0" });
    mark();
    emitRecord(serverRows.get(1), MAPPING);
    await sleep(30);
    eq(editorValue, "A0", "ligne 1 chargée dans l'éditeur");
    eq(newSets(), 1, "chargement → 1 seul setValue programmatique");
    eq(readOnlyNow, false, "édition autorisée");
    type("A1");
    await sleep(800); // debounce (500 ms) + résolution de l'écriture
    eq(newWrites().length, 1, "frappe → exactement 1 écriture après debounce");
    eq(newWrites()[0].id, 1, "écriture vers la ligne 1");
    eq(newWrites()[0].fields.code, "A1", "valeur écrite = texte tapé");
    eq(serverRows.get(1).code, "A1", "serveur mis à jour");
    mark();
    emitRecord({ id: 1, code: "A1" }, MAPPING); // écho de notre propre écriture
    await sleep(30);
    eq(newSets(), 0, "écho reconnu par l'état → aucune reconstruction");
    eq(editorValue, "A1", "contenu intact après écho");

    // --- S2: changement de ligne dans la fenêtre de debounce (la perte n°1) ---
    console.log("— S2: frappe puis changement de ligne dans la fenêtre de debounce");
    await settle();
    serverRows.set(2, { id: 2, code: "B0" });
    mark();
    type("A2-edit"); // frappe sur la ligne 1
    await sleep(100);
    emitRecord(serverRows.get(2), MAPPING); // l'utilisateur change de ligne
    await sleep(30);
    eq(editorValue, "B0", "ligne 2 affichée");
    const w2 = newWrites().filter(w => !w.failed);
    ok(w2.length === 1 && w2[0].id === 1 && w2[0].fields.code === "A2-edit",
        "flush au changement de ligne → le texte part dans la ligne d'origine (1)");
    eq(serverRows.get(1).code, "A2-edit", "serveur: ligne 1 = texte tapé");
    await sleep(800);
    ok(newWrites().length === 1, "aucune écriture parasite vers la ligne 2");

    // --- S3: onRecord rétroactif (trigger sur AUTRE colonne) pendant la frappe ---
    console.log("— S3: onRecord rétroactif pendant la frappe → éditeur intact");
    await settle();
    mark();
    type("B1-edit"); // frappe sur la ligne 2
    await sleep(100);
    // La ligne est re-délivrée parce qu'un trigger a changé une AUTRE colonne
    emitRecord({ id: 2, code: "B0", note: "trigger!" }, MAPPING);
    await sleep(30);
    eq(editorValue, "B1-edit", "saisie en attente → onRecord ignoré, texte intact");
    eq(newSets(), 0, "aucune reconstruction pendant la frappe en attente");
    await sleep(800);
    const w3 = newWrites().filter(w => !w.failed);
    ok(w3.length === 1 && w3[0].id === 2 && w3[0].fields.code === "B1-edit",
        "la saisie finit par être écrite dans la ligne 2");

    // --- S4: écriture en vol + écho rétroactif → aucune reconstruction ---
    console.log("— S4: écho rétroactif pendant une écriture en vol");
    await settle();
    updateLatencyMs = 300;
    mark();
    type("B1"); // remplace B1-edit
    await sleep(600); // debounce tiré à ~500 ms, écriture en vol jusqu'à ~800 ms
    // Écho rétroactif reçu PENDANT l'écriture en vol
    emitRecord({ id: 2, code: "B0", note: "écho pendant vol" }, MAPPING);
    eq(editorValue, "B1", "écriture en vol → écho ignoré, éditeur intact");
    eq(newSets(), 0, "aucune reconstruction pendant le vol");
    await sleep(400); // écriture résolue
    eq(serverRows.get(2).code, "B1", "serveur: ligne 2 = B1");
    emitRecord({ id: 2, code: "B1" }, MAPPING); // écho final propre
    await sleep(30);
    eq(newSets(), 0, "écho reconnu après le vol → pas de reconstruction");
    updateLatencyMs = 0;

    // --- S5: désélection (record null / mapping null) → flush + verrouillage ---
    console.log("— S5: désélection → flush des frappes en attente, puis verrou");
    await settle();
    mark();
    type("B2");
    emitRecord(null, null); // désélection
    await sleep(30);
    const w5 = newWrites().filter(w => !w.failed);
    ok(w5.length === 1 && w5[0].id === 2 && w5[0].fields.code === "B2",
        "frappe en attente flushée à la désélection");
    eq(readOnlyNow, true, "éditeur verrouillé après désélection");
    eq(editorValue, "", "éditeur vidé");
    mark();
    type("orphelin"); // frappe sans ligne courante : doit être ignorée
    await sleep(800);
    eq(newWrites().length, 0, "aucune frappe orpheline écrite");
    mark();
    emitRecord(serverRows.get(2), MAPPING); // re-sélection de la ligne 2
    await sleep(30);
    eq(editorValue, "B2", "re-sélection → valeur serveur rechargée");

    // --- S6: onNewRecord ("+") → flush AVANT de vider l'éditeur ---
    console.log("— S6: onNewRecord → flush puis éditeur vierge verrouillé");
    await settle();
    mark();
    type("B3");
    emitNewRecord();
    await sleep(30);
    const w6 = newWrites().filter(w => !w.failed);
    ok(w6.length === 1 && w6[0].id === 2 && w6[0].fields.code === "B3",
        "onNewRecord flushe la saisie de la ligne précédente");
    eq(readOnlyNow, true, "nouvelle ligne → verrouillé (pas d'id à écrire)");
    eq(editorValue, "", "éditeur vidé pour la nouvelle ligne");
    ok(chip && chip.textContent === "Nouvelle ligne", "pastille: Nouvelle ligne");
    serverRows.set(3, { id: 3, code: "" });
    mark();
    emitRecord(serverRows.get(3), MAPPING); // la ligne réelle arrive (id 3)
    await sleep(30);
    eq(readOnlyNow, false, "déverrouillé quand la vraie ligne arrive");

    // --- S7: pagehide → flush de secours ---
    console.log("— S7: pagehide pendant le debounce → flush");
    await settle();
    mark();
    type("C1");
    firePagehide();
    await sleep(30);
    const w7 = newWrites().filter(w => !w.failed);
    ok(w7.length === 1 && w7[0].id === 3 && w7[0].fields.code === "C1",
        "pagehide flush la saisie en attente");

    // --- S8: visibilitychange → hidden → flush de secours ---
    console.log("— S8: visibilitychange (hidden) → flush");
    await settle();
    mark();
    type("C2");
    fireVisibility(true);
    await sleep(30);
    const w8 = newWrites().filter(w => !w.failed);
    ok(w8.length === 1 && w8[0].id === 3 && w8[0].fields.code === "C2",
        "visibilitychange hidden flush la saisie en attente");
    fireVisibility(false);

    // --- S9: max-wait du debounce (frappe continue jamais en pause) ---
    console.log("— S9: frappe continue → le max-wait force l'enregistrement");
    await settle(); // la ligne 3 doit être chargée avant la frappe continue
    mark();
    type("texte 0");
    for (let i = 1; i <= 29; i++) {
        await sleep(120); // < DEBOUNCE_MS: le debounce ne s'exécute jamais seul
        type("texte " + i);
    }
    const duringTyping = newWrites().filter(w => !w.failed);
    ok(duringTyping.length >= 1, `max-wait (3 s) → écriture intermédiaire pendant la frappe continue (${duringTyping.length})`);
    eq(duringTyping[0].id, 3, "écriture intermédiaire dans la bonne ligne");
    await sleep(900); // debounce final après l'arrêt de la frappe
    const allS9 = newWrites().filter(w => !w.failed);
    ok(allS9.length >= 2 && allS9[allS9.length - 1].fields.code === "texte 29",
        "écriture finale avec la dernière valeur tapée");

    // --- S10: échec d'écriture → valeur retenue, re-tentative au prochain
    // --- déclencheur (changement de ligne), jamais de perte silencieuse ---
    console.log("— S10: échec d'écriture → retenue + re-tentative");
    await settle();
    serverRows.set(4, { id: 4, code: "D0" }); // la ligne cible du changement suivant
    failNext = 1;
    mark();
    type("C3");
    await sleep(800); // debounce → écriture qui échoue
    const w10a = newWrites();
    ok(w10a.length === 1 && w10a[0].failed, "1ʳᵉ écriture échoue (Access Rules simulées)");
    ok(chip && chip.textContent.indexOf("Échec") !== -1, "pastille d'erreur visible");
    emitRecord(serverRows.get(4), MAPPING); // l'utilisateur change de ligne (id 4)
    await sleep(100);
    const w10b = newWrites().filter(w => !w.failed && w.id === 3);
    ok(w10b.length === 1 && w10b[0].fields.code === "C3",
        "changement de ligne → re-tentative automatique avec la valeur retenue");
    eq(serverRows.get(3).code, "C3", "serveur: ligne 3 = C3 après re-tentative");
    eq(editorValue, "D0", "la nouvelle ligne s'affiche correctement");

    // --- S11: cellule null → "" (jamais "null", jamais de crash) ---
    console.log("— S11: cellule null chargée comme chaîne vide");
    await settle();
    mark();
    emitRecord({ id: 4, code: null }, MAPPING);
    await sleep(30);
    eq(editorValue, "", "null → éditeur vide (pas \"null\", pas de crash)");
    type("D1");
    await sleep(800);
    const w11 = newWrites().filter(w => !w.failed);
    ok(w11.length === 1 && w11[0].id === 4 && w11[0].fields.code === "D1",
        "frappe après chargement d'un null → écriture correcte");

    // --- S12: salve d'onRecord → coalescée (dernier état gagné) ---
    console.log("— S12: salve d'onRecord coalescée");
    await settle();
    mark();
    emitRecord({ id: 4, code: "D1", note: "a" }, MAPPING); // écho → mené en tête
    emitRecord({ id: 4, code: "D1", note: "b" }, MAPPING); // salve
    emitRecord({ id: 4, code: "D2-DISTANT", note: "c" }, MAPPING); // vrai changement distant
    await sleep(400); // > BURST_MS (250)
    eq(editorValue, "D2-DISTANT", "dernier état gagné → changement distant appliqué");
    eq(newSets(), 1, "3 callbacks → 1 seule application (les échos sont ignorés)");

    // --- S13: dé-mapping pendant la frappe → flush puis verrouillage ---
    console.log("— S13: dé-mapping (mapping null / colonne absente) → flush");
    await settle();
    mark();
    type("D3-edit");
    emitRecord({ id: 4, code: "D2-DISTANT" }, null); // mapping retiré
    await sleep(30);
    const w13 = newWrites().filter(w => !w.failed);
    ok(w13.length === 1 && w13[0].id === 4 && w13[0].fields.code === "D3-edit",
        "dé-mapping → saisie flushée vers la ligne d'origine");
    eq(readOnlyNow, true, "dé-mapping → éditeur verrouillé");
    emitRecord(serverRows.get(4), MAPPING); // re-mapping → rechargement
    await sleep(300); // > BURST_MS: le re-mapping arrive au trailing de la salve
    eq(editorValue, "D3-edit", "re-mapping → valeur serveur (D3-edit) rechargée");

    // --- S14: re-mapping même ligne vers une autre colonne → rechargement ---
    console.log("— S14: colonne mappée changée sur la même ligne → rechargement");
    await settle(); // la salve S13 doit être retombée (sinon coalescée)
    serverRows.set(4, { id: 4, code: "D3-edit", code2: "AUTRE COLONNE" });
    mark();
    emitRecord(serverRows.get(4), { code: "code2" });
    await sleep(30);
    eq(editorValue, "AUTRE COLONNE", "nouvelle colonne mappée → sa valeur est affichée");
    emitRecord(serverRows.get(4), MAPPING); // retour sur la colonne code
    await sleep(300); // > BURST_MS: le retour arrive au trailing de la salve
    eq(editorValue, "D3-edit", "retour sur la colonne code → valeur réaffichée");

    // --- S15: écriture no-op (retour à la valeur stockée) → rien envoyé ---
    console.log("— S15: frappe revenant à la valeur stockée → aucune écriture");
    await settle();
    mark();
    type("D3-edit"); // identique à la valeur serveur
    await sleep(800);
    eq(newWrites().length, 0, "valeur identique au serveur → écriture sautée");
    ok(chip && chip.textContent.indexOf("Enregistré") !== -1, "pastille: Enregistré");




    console.log(`\n${checks} vérifications, ${failures} échec(s)`);
    console.log(failures === 0 ? "TOUS LES TESTS PASSENT" : "ÉCHECS");
    return failures === 0 ? 0 : 1;
}

main().then(code => process.exit(code)).catch(e => { console.error("ERREUR HARNAIS:", e); process.exit(2); });
