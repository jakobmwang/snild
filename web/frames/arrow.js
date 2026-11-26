// Apache Arrow ships as a UMD bundle, not a module: duckdb.html loads it as a classic script (it sets
// globalThis.Arrow), and this module hands DuckDB, which imports "apache-arrow", the parts it uses.
const { RecordBatchReader, Table, Type, tableToIPC } = globalThis.Arrow;
export { RecordBatchReader, Table, Type, tableToIPC };
