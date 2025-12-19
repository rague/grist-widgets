grist.ready({
    columns: [
        {
            name: "numeric",
            title: "Colonne numérique",
            type: "Numeric, Int", // spécification du type de colonne
        }
    ],
    requiredAccess: 'read table', // nécessaire pour lire les données de la table
});
grist.onRecords((records, mappings) => {

    const container = document.getElementById("content");

    const mappedRecords = grist.mapColumnNames(records, mappings);
    const total = mappedRecordsi.reduce((acc, cur) => acc + cur["numeric"], 0);

    container.innerHTML = total.toLocaleString();
    document.getElementsByTagName("body")[0].scrollLeft = -1000;

});
grist.onRecord(record => {

});
