// Daily job (ADR 0002, RRF): embeds the material names that have no embedding or were renamed, so a near match can
// rank by meaning. Names are master data, not personal data. 100 names per embedding call; saves of 25 rows keep
// each request small. The database saves a vector only while the name is still the one that was embedded.
// A run starts batches for budgetMs and leaves the rest of the queue to the next run; a batch costs about 6 s.
export async function embedMaterialNames({ rpc, embed, signal, batches = 60, budgetMs = 60_000, now = Date.now }) {
  const started = now();
  let embedded = 0, saved = 0;
  try {
    for (let batch = 0; batch < batches && !signal.aborted && now() - started < budgetMs; batch++) {
      const queue = await rpc('material_embedding_queue', { p_limit: 100 });
      if (!Array.isArray(queue) || !queue.length) return { status: 'done', embedded, saved };
      const vectors = await embed(queue.map(row => row.material_name), signal);
      const rows = queue.map((row, i) => ({ material_id: row.material_id, material_name: row.material_name,
        embedding: `[${vectors[i].map(value => Number(value.toFixed(6))).join(',')}]` }));
      for (let start = 0; start < rows.length; start += 25) saved += await rpc('material_embedding_save', { p_rows: rows.slice(start, start + 25) });
      embedded += queue.length;
    }
  } catch (error) {
    // The run's deadline cut a batch short: what was saved stays saved, and the next run picks up the rest.
    if (!signal.aborted) throw error;
  }
  return { status: 'partial', embedded, saved };
}
