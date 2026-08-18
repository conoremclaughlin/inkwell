import winston from 'winston';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { env } from '../config/env';

// Ink log directory in user's home
const INK_LOG_DIR = join(homedir(), '.ink', 'logs');

/**
 * Under test, this module must NOT touch ~/.ink/logs.
 *
 * Importing the logger attached File transports to the operator's REAL log
 * files, so every unit test run appended its output to the same combined.log
 * the server writes to. Fabricated test values then read as production events:
 * `memory-repository.test.ts` mocks a 768-dim `nomic-embed-text` query against
 * 1024-dim storage purely to exercise a guard, and 118 copies of
 * "Skipping semantic recall due to embedding dimension mismatch" accumulated in
 * combined.log — indistinguishable from a live misconfiguration, and
 * investigated as one. The real config was correct the whole time.
 *
 * Console output stays on so test failures remain debuggable; only the file
 * side effects are suppressed.
 */
const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

// Ensure log directory exists (never as a side effect of a test importing this)
if (!isTestEnv && !existsSync(INK_LOG_DIR)) {
  mkdirSync(INK_LOG_DIR, { recursive: true });
}

const fileTransports = isTestEnv
  ? []
  : [
      // Write all logs with level 'error' and below to error.log
      new winston.transports.File({
        filename: join(INK_LOG_DIR, 'error.log'),
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5,
        tailable: true,
      }),
      // Write all logs to combined.log
      new winston.transports.File({
        filename: join(INK_LOG_DIR, 'combined.log'),
        maxsize: 10485760, // 10MB
        maxFiles: 5,
        tailable: true,
      }),
    ];

const fileExceptionHandlers = isTestEnv
  ? []
  : [new winston.transports.File({ filename: join(INK_LOG_DIR, 'exceptions.log') })];

const fileRejectionHandlers = isTestEnv
  ? []
  : [new winston.transports.File({ filename: join(INK_LOG_DIR, 'rejections.log') })];

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaString}`;
  })
);

// Create logger instance
export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: logFormat,
  defaultMeta: { service: 'inkwell' },
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: consoleFormat,
    }),
    ...fileTransports,
  ],
  exceptionHandlers: [
    new winston.transports.Console({ format: consoleFormat }),
    ...fileExceptionHandlers,
  ],
  rejectionHandlers: [
    new winston.transports.Console({ format: consoleFormat }),
    ...fileRejectionHandlers,
  ],
});

// If in production, don't log to console
if (env.NODE_ENV === 'production') {
  logger.remove(new winston.transports.Console());
}

export default logger;
