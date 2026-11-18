/**
 * ServiceRegistry
 *
 * Static service registry backed by environment variables.
 * Maps a service name (sent in x-sentio-service header) to a base URL.
 *
 * To add a new service:
 *   1. Add SENTIO_SVC_<UPPERCASE_NAME>=http://host:port  to .env
 *   2. No gateway restart needed if using dynamic env injection (Docker / K8s ConfigMap).
 *
 * Future: swap resolve() internals for Redis without changing any proxy code.
 */

const PREFIX = 'SENTIO_SVC_';

class ServiceRegistry {
  constructor() {
    // Build registry at startup from environment variables.
    // e.g. SENTIO_SVC_NODE_BACKEND=http://localhost:3000
    //      SENTIO_SVC_FASTAPI_BACKEND=http://localhost:8000
    this._registry = this._loadFromEnv();

    console.log('[ServiceRegistry] Loaded services:');
    for (const [name, url] of Object.entries(this._registry)) {
      console.log(`  ${name} → ${url}`);
    }
  }

  /**
   * Reads all SENTIO_SVC_* env vars and normalises keys to lowercase-hyphen.
   * SENTIO_SVC_NODE_BACKEND  → "node-backend"
   * SENTIO_SVC_FASTAPI_BACKEND → "fastapi-backend"
   */
  _loadFromEnv() {
    const registry = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(PREFIX) && value) {
        const name = key
          .slice(PREFIX.length)       // strip SENTIO_SVC_
          .toLowerCase()
          .replace(/_/g, '-');        // NODE_BACKEND → node-backend
        registry[name] = value.replace(/\/$/, ''); // strip trailing slash
      }
    }
    return registry;
  }

  /**
   * Resolves a service name to its base URL.
   *
   * @param {string} serviceName  Value from x-sentio-service header
   * @returns {string | null}     Base URL, or null if not registered
   */
  resolve(serviceName) {
    if (!serviceName) return null;
    return this._registry[serviceName.toLowerCase().trim()] || null;
  }

  /**
   * Returns all registered service names.
   */
  list() {
    return Object.keys(this._registry);
  }
}

// Singleton — shared across the process
module.exports = new ServiceRegistry();
