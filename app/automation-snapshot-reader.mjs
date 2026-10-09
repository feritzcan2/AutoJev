// One synchronous UI read shares repeated lookups. Nothing survives the
// snapshot, so writes, rollbacks and other workers cannot leave stale state.
export function automationSnapshotReader(store) {
  const reader = Object.create(store);
  for (const method of ['get', 'run', 'runs']) {
    const values = new Map();
    reader[method] = (...args) => {
      const key = JSON.stringify(args);
      if (!values.has(key)) values.set(key, store[method].apply(reader, args));
      return values.get(key);
    };
  }
  return reader;
}
