import { Pagination } from './common.js';

// API Response types

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta?: {
    pagination?: Pagination;
    [key: string]: unknown;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

// Helper function to create success response
export function createSuccessResponse<T>(
  data: T,
  meta?: ApiSuccessResponse<T>['meta']
): ApiSuccessResponse<T> {
  const response: ApiSuccessResponse<T> = {
    success: true,
    data,
  };
  if (meta) {
    response.meta = meta;
  }
  return response;
}

// Helper function to create error response
export function createErrorResponse(
  code: string,
  message: string,
  details?: unknown
): ApiErrorResponse {
  const error: ApiErrorResponse['error'] = {
    code,
    message,
  };
  if (details !== undefined) {
    error.details = details;
  }
  return {
    success: false,
    error,
  };
}
