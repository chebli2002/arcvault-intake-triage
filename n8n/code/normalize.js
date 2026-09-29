// n8n Code node 2: Normalize & Validate
// TODO (Block 2). Trim whitespace, reject empty messages, compute
// request_id = hash(source + normalized message), set received_at.
// Export a pure function; keep the n8n wrapper ($input.all() -> items) thin.

function normalize(item) {
  throw new Error('not implemented');
}

module.exports = { normalize };
