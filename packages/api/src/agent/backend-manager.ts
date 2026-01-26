/**
 * Backend Manager
 *
 * Manages agent backend lifecycle, selection, and failover.
 * Provides a unified interface for the session host to interact with
 * different backend implementations.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import type {
  AgentBackend,
  AgentMessage,
  BackendHealth,
  BackendType,
  ResponseHandler,
} from './types';
import type { ClaudeCodeConfig } from './backends/claude-code.backend';
import type { DirectApiConfig } from './backends/direct-api.backend';
import { ClaudeCodeBackend, createClaudeCodeBackend } from './backends/claude-code.backend';
import { DirectApiBackend, createDirectApiBackend } from './backends/direct-api.backend';

export interface BackendManagerConfig {
  /** Primary backend to use */
  primaryBackend: BackendType;
  /** Fallback backend if primary fails */
  fallbackBackend?: BackendType;
  /** Backend-specific configurations */
  backends: {
    'claude-code'?: Partial<ClaudeCodeConfig>;
    'direct-api'?: Partial<DirectApiConfig>;
  };
  /** Enable automatic failover */
  enableFailover?: boolean;
  /** Health check interval in ms */
  healthCheckInterval?: number;
}

const DEFAULT_CONFIG: Partial<BackendManagerConfig> = {
  primaryBackend: 'claude-code',
  enableFailover: true,
  healthCheckInterval: 30000,
};

export class BackendManager extends EventEmitter {
  private config: BackendManagerConfig;
  private backends: Map<BackendType, AgentBackend> = new Map();
  private activeBackend: AgentBackend | null = null;
  private responseHandler: ResponseHandler | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<BackendManagerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as BackendManagerConfig;
  }

  /**
   * Initialize the backend manager and start the primary backend
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Backend Manager...');

    // Create backends based on config
    await this.createBackends();

    // Start primary backend
    await this.activateBackend(this.config.primaryBackend);

    // Start health checks
    if (this.config.healthCheckInterval) {
      this.startHealthChecks();
    }

    logger.info('Backend Manager initialized', {
      primary: this.config.primaryBackend,
      fallback: this.config.fallbackBackend,
    });
  }

  /**
   * Shutdown all backends
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Backend Manager...');

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    const shutdownPromises = Array.from(this.backends.values()).map(
      backend => backend.shutdown().catch(err => logger.error('Backend shutdown error:', err))
    );

    await Promise.all(shutdownPromises);
    this.backends.clear();
    this.activeBackend = null;

    logger.info('Backend Manager shutdown complete');
  }

  /**
   * Send a message to the active backend
   */
  async sendMessage(message: AgentMessage): Promise<void> {
    if (!this.activeBackend) {
      throw new Error('No active backend available');
    }

    if (!this.activeBackend.isReady()) {
      // Try failover
      if (this.config.enableFailover && this.config.fallbackBackend) {
        logger.warn('Primary backend not ready, attempting failover...');
        await this.failover();
      } else {
        throw new Error('Backend not ready and failover disabled');
      }
    }

    try {
      await this.activeBackend.sendMessage(message);
    } catch (error) {
      logger.error('Backend message error:', error);

      // Attempt failover on error
      if (this.config.enableFailover && this.config.fallbackBackend) {
        await this.failover();
        await this.activeBackend!.sendMessage(message);
      } else {
        throw error;
      }
    }
  }

  /**
   * Register the response handler
   */
  setResponseHandler(handler: ResponseHandler): void {
    this.responseHandler = handler;

    // Pass to direct API backend if it exists
    const directApi = this.backends.get('direct-api') as DirectApiBackend | undefined;
    if (directApi) {
      directApi.setResponseHandler(handler);
    }
  }

  /**
   * Get the active backend
   */
  getActiveBackend(): AgentBackend | null {
    return this.activeBackend;
  }

  /**
   * Get the active backend type
   */
  getActiveBackendType(): BackendType | null {
    return this.activeBackend?.type || null;
  }

  /**
   * Get health status of all backends
   */
  getAllHealth(): Record<BackendType, BackendHealth> {
    const health: Record<string, BackendHealth> = {};
    for (const [type, backend] of this.backends) {
      health[type] = backend.getHealth();
    }
    return health as Record<BackendType, BackendHealth>;
  }

  /**
   * Switch to a specific backend
   */
  async switchBackend(type: BackendType): Promise<void> {
    if (!this.backends.has(type)) {
      throw new Error(`Backend not available: ${type}`);
    }

    await this.activateBackend(type);
    logger.info(`Switched to backend: ${type}`);
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.activeBackend?.getSessionId() || null;
  }

  /**
   * Resume a previous session
   */
  async resumeSession(sessionId: string, backendType?: BackendType): Promise<boolean> {
    const type = backendType || this.config.primaryBackend;
    const backend = this.backends.get(type);

    if (!backend?.resumeSession) {
      return false;
    }

    return backend.resumeSession(sessionId);
  }

  /**
   * Get the Claude Code backend (for pending message access)
   */
  getClaudeCodeBackend(): ClaudeCodeBackend | null {
    return this.backends.get('claude-code') as ClaudeCodeBackend || null;
  }

  private async createBackends(): Promise<void> {
    // Create Claude Code backend
    if (this.config.backends['claude-code'] || this.config.primaryBackend === 'claude-code') {
      const backend = createClaudeCodeBackend(this.config.backends['claude-code']);
      this.setupBackendEvents(backend);
      this.backends.set('claude-code', backend);
    }

    // Create Direct API backend
    if (this.config.backends['direct-api'] || this.config.primaryBackend === 'direct-api') {
      const backend = createDirectApiBackend(this.config.backends['direct-api']);
      this.setupBackendEvents(backend);
      if (this.responseHandler) {
        backend.setResponseHandler(this.responseHandler);
      }
      this.backends.set('direct-api', backend);
    }
  }

  private setupBackendEvents(backend: AgentBackend): void {
    backend.on('ready', () => {
      this.emit('backend:ready', backend.type);
    });

    backend.on('error', (error: Error) => {
      this.emit('backend:error', { type: backend.type, error });
    });

    backend.on('exit', (code: number) => {
      this.emit('backend:exit', { type: backend.type, code });

      // Attempt restart if this was the active backend
      if (this.activeBackend === backend && this.config.enableFailover) {
        this.handleBackendExit(backend.type);
      }
    });

    backend.on('text', (text: string) => {
      this.emit('text', text);
    });

    backend.on('result', (result: unknown) => {
      this.emit('result', result);
    });

    backend.on('response', (response: unknown) => {
      this.emit('response', response);
    });
  }

  private async activateBackend(type: BackendType): Promise<void> {
    const backend = this.backends.get(type);
    if (!backend) {
      throw new Error(`Backend not found: ${type}`);
    }

    if (!backend.isReady()) {
      await backend.initialize();
    }

    this.activeBackend = backend;
    this.emit('backend:activated', type);
  }

  private async failover(): Promise<void> {
    if (!this.config.fallbackBackend) {
      throw new Error('No fallback backend configured');
    }

    logger.warn(`Failing over to ${this.config.fallbackBackend}...`);
    await this.activateBackend(this.config.fallbackBackend);
    this.emit('backend:failover', this.config.fallbackBackend);
  }

  private async handleBackendExit(type: BackendType): Promise<void> {
    logger.warn(`Backend ${type} exited unexpectedly`);

    if (type === this.activeBackend?.type) {
      // Try failover first
      if (this.config.fallbackBackend && type !== this.config.fallbackBackend) {
        try {
          await this.failover();
          return;
        } catch (error) {
          logger.error('Failover failed:', error);
        }
      }

      // Try to restart the same backend
      try {
        logger.info(`Attempting to restart ${type}...`);
        const backend = this.backends.get(type);
        if (backend) {
          await backend.initialize();
          this.activeBackend = backend;
          logger.info(`Backend ${type} restarted successfully`);
        }
      } catch (error) {
        logger.error(`Failed to restart ${type}:`, error);
        this.emit('backend:failed', type);
      }
    }
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      for (const [type, backend] of this.backends) {
        const health = backend.getHealth();
        if (!health.healthy && backend === this.activeBackend) {
          logger.warn(`Active backend ${type} unhealthy:`, health.error);
          this.emit('backend:unhealthy', { type, health });
        }
      }
    }, this.config.healthCheckInterval);
  }
}

/**
 * Create a backend manager instance
 */
export function createBackendManager(config: Partial<BackendManagerConfig>): BackendManager {
  return new BackendManager(config);
}
