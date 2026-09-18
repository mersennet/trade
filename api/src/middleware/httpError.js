/**
 * One place that turns a caught exception into an HTTP answer.
 *
 * Postgres input errors (a non-numeric id in an integer column, a malformed
 * timestamp, an out-of-range number) are the client's fault: answer 400 with
 * a plain message. Everything else is ours: log it with the route, answer a
 * generic 500, and never echo driver text — column names and SQL fragments
 * are not something a public API should hand out.
 */
const PG_BAD_INPUT = new Set([
  '22P02', // invalid_text_representation ("invalid input syntax for type integer")
  '22003', // numeric_value_out_of_range
  '22007', // invalid_datetime_format
  '22008', // datetime_field_overflow
  '22001', // string_data_right_truncation
  '2201X', // invalid_row_count_in_result_offset_clause
  '2201W', // invalid_row_count_in_limit_clause
  '22023', // invalid_parameter_value
]);

function isBadInput(e) {
  if (!e) return false;
  if (PG_BAD_INPUT.has(e.code)) return true;
  // Node/BigInt/Date parsing of a bad query parameter.
  if (e instanceof RangeError || e instanceof SyntaxError) return true;
  if (/^Cannot convert .* to a BigInt$/.test(e.message || '')) return true;
  if (/^Invalid time value$/.test(e.message || '')) return true;
  return false;
}

/** `sendError(res, e, 'orders')` — use from a route's catch block. */
function sendError(res, e, where) {
  if (res.headersSent) return;
  if (isBadInput(e)) {
    return res.status(400).json({ error: 'Invalid parameter', detail: publicDetail(e) });
  }
  console.error(`[${where || 'api'}]`, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
  return res.status(500).json({ error: 'Internal error' });
}

function publicDetail(e) {
  if (e.code === '22P02') return 'a numeric id or a valid timestamp was expected';
  if (e.code === '22003') return 'number out of range';
  if (e.code === '22007' || e.code === '22008' || /Invalid time value/.test(e.message || '')) return 'invalid date or timestamp';
  return undefined;
}

/** Express error middleware for anything thrown outside a route's try/catch. */
function errorMiddleware(err, req, res, _next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  sendError(res, err, `${req.method} ${req.path}`);
}

module.exports = { sendError, errorMiddleware, isBadInput };
