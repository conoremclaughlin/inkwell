import winston from 'winston';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { env } from '../config/env';

// PCP log directory in user's home
const PCP_LOG_DIR = join(homedir(), '.pcp', 'logs');

// Ensure log directory exists
if (!existsSync(PCP_LOG_DIR)) {
  mkdirSync(PCP_LOG_DIR, { recursive: true });
}

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
  defaultMeta: { service: 'personal-context-protocol' },
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // Write all logs with level 'error' and below to error.log
    new winston.transports.File({
      filename: join(PCP_LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true,
    }),
    // Write all logs to combined.log
    new winston.transports.File({
      filename: join(PCP_LOG_DIR, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: join(PCP_LOG_DIR, 'exceptions.log') }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: join(PCP_LOG_DIR, 'rejections.log') }),
  ],
});

// If in production, don't log to console
if (env.NODE_ENV === 'production') {
  logger.remove(new winston.transports.Console());
}

export default logger;
