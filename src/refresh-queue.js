// Coalesce change notifications while a snapshot is in flight. One later read
// observes changes that arrived during it, without queuing duplicate reads.
export function coalesceRefresh(read, {gap = 0} = {}) {
  let pending = null,
    again = false;
  return () => {
    again = true;
    if (!pending)
      pending = Promise.resolve()
        .then(async () => {
          do {
            again = false;
            await read();
            // Changes that keep arriving wait for the gap instead of reading back to back.
            if (again && gap) await new Promise((resolve) => setTimeout(resolve, gap));
          } while (again);
        })
        .finally(() => {
          pending = null;
        });
    return pending;
  };
}
