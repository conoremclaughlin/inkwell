import type { Database } from '../supabase/types';
import type { Platform } from '../../types/shared';

export type Link = Database['public']['Tables']['links']['Row'];
export type LinkInsert = Database['public']['Tables']['links']['Insert'];
export type LinkUpdate = Database['public']['Tables']['links']['Update'];

export interface LinkMetadata {
  favicon?: string;
  imageUrl?: string;
  siteName?: string;
  author?: string;
  publishedDate?: string;
  [key: string]: unknown;
}

export interface CreateLinkDTO {
  user_id: string;
  url: string;
  title?: string;
  description?: string;
  tags?: string[];
  source?: Platform;
  metadata?: LinkMetadata;
}

export interface UpdateLinkDTO {
  title?: string;
  description?: string;
  tags?: string[];
  metadata?: LinkMetadata;
}

export interface SearchLinksOptions {
  query?: string;
  tags?: string[];
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}
