let requestCount = 0;
let errorCount = 0;
let totalLatency = 0;
const routeHits = {};
const wsConnections = { current: 0, total: 0 };

function metricsMiddleware(req, res, next) {
  const start = Date.now();
  requestCount++;
  const route = req.path;
  routeHits[route] = (routeHits[route] || 0) + 1;

  res.on('finish', () => {
    const latency = Date.now() - start;
    totalLatency += latency;
    if (res.statusCode >= 400) errorCount++;
  });

  next();
}

function getMetrics() {
  return {
    requests_total: requestCount,
    errors_total: errorCount,
    avg_latency_ms: requestCount > 0 ? (totalLatency / requestCount).toFixed(2) : 0,
    ws_connections_current: wsConnections.current,
    ws_connections_total: wsConnections.total,
    top_routes: Object.entries(routeHits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([route, count]) => ({ route, count })),
    uptime_seconds: process.uptime().toFixed(0),
    memory_mb: (process.memoryUsage().rss / 1048576).toFixed(1),
  };
}

function prometheusFormat() {
  const m = getMetrics();
  return [
    `# HELP mersennet_trade_requests_total Total API requests`,
    `# TYPE mersennet_trade_requests_total counter`,
    `mersennet_trade_requests_total ${m.requests_total}`,
    `# HELP mersennet_trade_errors_total Total API errors`,
    `# TYPE mersennet_trade_errors_total counter`,
    `mersennet_trade_errors_total ${m.errors_total}`,
    `# HELP mersennet_trade_avg_latency_ms Average latency`,
    `# TYPE mersennet_trade_avg_latency_ms gauge`,
    `mersennet_trade_avg_latency_ms ${m.avg_latency_ms}`,
    `# HELP mersennet_trade_ws_connections WebSocket connections`,
    `# TYPE mersennet_trade_ws_connections gauge`,
    `mersennet_trade_ws_connections ${m.ws_connections_current}`,
    `# HELP mersennet_trade_uptime_seconds Uptime`,
    `# TYPE mersennet_trade_uptime_seconds gauge`,
    `mersennet_trade_uptime_seconds ${m.uptime_seconds}`,
    `# HELP mersennet_trade_memory_mb Memory RSS`,
    `# TYPE mersennet_trade_memory_mb gauge`,
    `mersennet_trade_memory_mb ${m.memory_mb}`,
  ].join('\n');
}

module.exports = { metricsMiddleware, getMetrics, prometheusFormat, wsConnections };
