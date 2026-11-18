const path = require('path');
require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  GRPC_TARGET: process.env.GRPC_TARGET || 'localhost:50051',
  PROTO_PATH: process.env.PROTO_PATH || path.resolve(__dirname, '../proto/sentio_gateway.proto'),

  // Concurrency & Limits
  MAX_CONNECTIONS: parseInt(process.env.MAX_CONNECTIONS || '500', 10),
  MAX_CONNECTIONS_PER_USER: parseInt(process.env.MAX_CONNECTIONS_PER_USER || '3', 10),

  // Heartbeat & Timeouts
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10),
  HEARTBEAT_TIMEOUT_MS: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '30000', 10),

  // Backpressure thresholds
  MAX_WS_BUFFER_BYTES: parseInt(process.env.MAX_WS_BUFFER_BYTES || '65536', 10), // 64 KB
  GRPC_RECONNECT_MAX_ATTEMPTS: parseInt(process.env.GRPC_RECONNECT_MAX_ATTEMPTS || '5', 10),
  GRPC_RECONNECT_BASE_DELAY_MS: parseInt(process.env.GRPC_RECONNECT_BASE_DELAY_MS || '500', 10),

  // Google OAuth Credentials
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'postmessage',
  GOOGLE_CLIENT_IDS: (process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
};
