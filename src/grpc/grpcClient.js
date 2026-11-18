const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const config = require('../config');

let clientInstance = null;
let protoDescriptor = null;

/**
 * Loads the protobuf definition dynamically.
 */
function loadProto() {
  if (!protoDescriptor) {
    const packageDefinition = protoLoader.loadSync(config.PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  }
  return protoDescriptor.sentio.gateway;
}

/**
 * Creates or retrieves the singleton gRPC client for SentioLiveGateway.
 */

function getGatewayClient() {
  if (!clientInstance) {
    const proto = loadProto();
    const options = {
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.http2.max_pings_without_data': 0,
      'grpc.max_receive_message_length': 16 * 1024 * 1024,
      'grpc.max_send_message_length': 16 * 1024 * 1024,
    };

    clientInstance = new proto.SentioLiveGateway(
      config.GRPC_TARGET,
      grpc.credentials.createInsecure(),
      options
    );
  }
  return clientInstance;
}

/**
 * Opens a new bidirectional stream for a session.
 */
function createSessionStream() {
  const client = getGatewayClient();
  return client.StreamSession();
}

/**
 * Checks gRPC connectivity state.
 */

function checkConnectivity() {
  const client = getGatewayClient();
  const channel = client.getChannel();
  return channel.getConnectivityState(true);
}

module.exports = {
  loadProto,
  getGatewayClient,
  createSessionStream,
  checkConnectivity,
};
