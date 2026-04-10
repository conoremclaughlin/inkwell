export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '13.0.5';
  };
  public: {
    Tables: {
      activity_stream: {
        Row: {
          agent_id: string;
          artifact_id: string | null;
          child_session_id: string | null;
          completed_at: string | null;
          contact_id: string | null;
          content: string;
          correlation_id: string | null;
          created_at: string;
          duration_ms: number | null;
          id: string;
          identity_id: string | null;
          is_dm: boolean | null;
          parent_id: string | null;
          payload: Json;
          platform: string | null;
          platform_chat_id: string | null;
          platform_message_id: string | null;
          session_id: string | null;
          status: string | null;
          subtype: string | null;
          type: Database['public']['Enums']['activity_type'];
          user_id: string;
        };
        Insert: {
          agent_id: string;
          artifact_id?: string | null;
          child_session_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          content: string;
          correlation_id?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          id?: string;
          identity_id?: string | null;
          is_dm?: boolean | null;
          parent_id?: string | null;
          payload?: Json;
          platform?: string | null;
          platform_chat_id?: string | null;
          platform_message_id?: string | null;
          session_id?: string | null;
          status?: string | null;
          subtype?: string | null;
          type: Database['public']['Enums']['activity_type'];
          user_id: string;
        };
        Update: {
          agent_id?: string;
          artifact_id?: string | null;
          child_session_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          content?: string;
          correlation_id?: string | null;
          created_at?: string;
          duration_ms?: number | null;
          id?: string;
          identity_id?: string | null;
          is_dm?: boolean | null;
          parent_id?: string | null;
          payload?: Json;
          platform?: string | null;
          platform_chat_id?: string | null;
          platform_message_id?: string | null;
          session_id?: string | null;
          status?: string | null;
          subtype?: string | null;
          type?: Database['public']['Enums']['activity_type'];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'activity_stream_contact_id_fkey';
            columns: ['contact_id'];
            isOneToOne: false;
            referencedRelation: 'contacts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'activity_stream_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'activity_stream_parent_id_fkey';
            columns: ['parent_id'];
            isOneToOne: false;
            referencedRelation: 'activity_stream';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'activity_stream_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'activity_stream_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_identities: {
        Row: {
          agent_id: string;
          backend: string | null;
          capabilities: Json | null;
          created_at: string | null;
          description: string | null;
          heartbeat: string | null;
          id: string;
          metadata: Json | null;
          name: string;
          permissions: Json;
          relationships: Json | null;
          role: string;
          session_scope: string;
          soul: string | null;
          studio_hint: string | null;
          updated_at: string | null;
          user_id: string;
          values: Json | null;
          version: number | null;
          workspace_id: string | null;
        };
        Insert: {
          agent_id: string;
          backend?: string | null;
          capabilities?: Json | null;
          created_at?: string | null;
          description?: string | null;
          heartbeat?: string | null;
          id?: string;
          metadata?: Json | null;
          name: string;
          permissions?: Json;
          relationships?: Json | null;
          role: string;
          session_scope?: string;
          soul?: string | null;
          studio_hint?: string | null;
          updated_at?: string | null;
          user_id: string;
          values?: Json | null;
          version?: number | null;
          workspace_id?: string | null;
        };
        Update: {
          agent_id?: string;
          backend?: string | null;
          capabilities?: Json | null;
          created_at?: string | null;
          description?: string | null;
          heartbeat?: string | null;
          id?: string;
          metadata?: Json | null;
          name?: string;
          permissions?: Json;
          relationships?: Json | null;
          role?: string;
          session_scope?: string;
          soul?: string | null;
          studio_hint?: string | null;
          updated_at?: string | null;
          user_id?: string;
          values?: Json | null;
          version?: number | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_identities_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_identities_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_identity_history: {
        Row: {
          agent_id: string;
          archived_at: string | null;
          backend: string | null;
          capabilities: Json | null;
          change_type: string;
          created_at: string;
          description: string | null;
          heartbeat: string | null;
          id: string;
          identity_id: string;
          metadata: Json | null;
          name: string;
          permissions: Json;
          relationships: Json | null;
          role: string;
          soul: string | null;
          user_id: string;
          values: Json | null;
          version: number;
          workspace_id: string | null;
        };
        Insert: {
          agent_id: string;
          archived_at?: string | null;
          backend?: string | null;
          capabilities?: Json | null;
          change_type?: string;
          created_at: string;
          description?: string | null;
          heartbeat?: string | null;
          id?: string;
          identity_id: string;
          metadata?: Json | null;
          name: string;
          permissions?: Json;
          relationships?: Json | null;
          role: string;
          soul?: string | null;
          user_id: string;
          values?: Json | null;
          version: number;
          workspace_id?: string | null;
        };
        Update: {
          agent_id?: string;
          archived_at?: string | null;
          backend?: string | null;
          capabilities?: Json | null;
          change_type?: string;
          created_at?: string;
          description?: string | null;
          heartbeat?: string | null;
          id?: string;
          identity_id?: string;
          metadata?: Json | null;
          name?: string;
          permissions?: Json;
          relationships?: Json | null;
          role?: string;
          soul?: string | null;
          user_id?: string;
          values?: Json | null;
          version?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_identity_history_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_identity_history_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_inbox: {
        Row: {
          acknowledged_at: string | null;
          content: string;
          created_at: string | null;
          expires_at: string | null;
          id: string;
          message_type: string;
          metadata: Json | null;
          priority: string;
          read_at: string | null;
          recipient_agent_id: string;
          recipient_identity_id: string | null;
          recipient_session_id: string | null;
          recipient_user_id: string;
          related_artifact_uri: string | null;
          sender_agent_id: string | null;
          sender_identity_id: string | null;
          sender_user_id: string | null;
          status: string;
          subject: string | null;
          thread_key: string | null;
        };
        Insert: {
          acknowledged_at?: string | null;
          content: string;
          created_at?: string | null;
          expires_at?: string | null;
          id?: string;
          message_type?: string;
          metadata?: Json | null;
          priority?: string;
          read_at?: string | null;
          recipient_agent_id: string;
          recipient_identity_id?: string | null;
          recipient_session_id?: string | null;
          recipient_user_id: string;
          related_artifact_uri?: string | null;
          sender_agent_id?: string | null;
          sender_identity_id?: string | null;
          sender_user_id?: string | null;
          status?: string;
          subject?: string | null;
          thread_key?: string | null;
        };
        Update: {
          acknowledged_at?: string | null;
          content?: string;
          created_at?: string | null;
          expires_at?: string | null;
          id?: string;
          message_type?: string;
          metadata?: Json | null;
          priority?: string;
          read_at?: string | null;
          recipient_agent_id?: string;
          recipient_identity_id?: string | null;
          recipient_session_id?: string | null;
          recipient_user_id?: string;
          related_artifact_uri?: string | null;
          sender_agent_id?: string | null;
          sender_identity_id?: string | null;
          sender_user_id?: string | null;
          status?: string;
          subject?: string | null;
          thread_key?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_inbox_recipient_identity_id_fkey';
            columns: ['recipient_identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_inbox_recipient_session_id_fkey';
            columns: ['recipient_session_id'];
            isOneToOne: false;
            referencedRelation: 'sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_inbox_recipient_user_id_fkey';
            columns: ['recipient_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_inbox_sender_identity_id_fkey';
            columns: ['sender_identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_inbox_sender_user_id_fkey';
            columns: ['sender_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_sessions: {
        Row: {
          backend: string;
          created_at: string;
          ended_at: string | null;
          id: string;
          last_activity_at: string;
          mcp_config_path: string | null;
          message_count: number | null;
          model: string | null;
          platform: string | null;
          platform_chat_id: string | null;
          session_id: string;
          session_key: string | null;
          status: string;
          total_cost: number | null;
          updated_at: string;
          user_id: string;
          working_directory: string | null;
        };
        Insert: {
          backend?: string;
          created_at?: string;
          ended_at?: string | null;
          id?: string;
          last_activity_at?: string;
          mcp_config_path?: string | null;
          message_count?: number | null;
          model?: string | null;
          platform?: string | null;
          platform_chat_id?: string | null;
          session_id: string;
          session_key?: string | null;
          status?: string;
          total_cost?: number | null;
          updated_at?: string;
          user_id: string;
          working_directory?: string | null;
        };
        Update: {
          backend?: string;
          created_at?: string;
          ended_at?: string | null;
          id?: string;
          last_activity_at?: string;
          mcp_config_path?: string | null;
          message_count?: number | null;
          model?: string | null;
          platform?: string | null;
          platform_chat_id?: string | null;
          session_id?: string;
          session_key?: string | null;
          status?: string;
          total_cost?: number | null;
          updated_at?: string;
          user_id?: string;
          working_directory?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_sessions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      artifact_comments: {
        Row: {
          artifact_id: string;
          content: string;
          created_at: string | null;
          created_by_identity_id: string | null;
          created_by_user_id: string | null;
          deleted_at: string | null;
          id: string;
          metadata: Json | null;
          parent_comment_id: string | null;
          updated_at: string | null;
          user_id: string;
          workspace_id: string | null;
        };
        Insert: {
          artifact_id: string;
          content: string;
          created_at?: string | null;
          created_by_identity_id?: string | null;
          created_by_user_id?: string | null;
          deleted_at?: string | null;
          id?: string;
          metadata?: Json | null;
          parent_comment_id?: string | null;
          updated_at?: string | null;
          user_id: string;
          workspace_id?: string | null;
        };
        Update: {
          artifact_id?: string;
          content?: string;
          created_at?: string | null;
          created_by_identity_id?: string | null;
          created_by_user_id?: string | null;
          deleted_at?: string | null;
          id?: string;
          metadata?: Json | null;
          parent_comment_id?: string | null;
          updated_at?: string | null;
          user_id?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'artifact_comments_artifact_id_fkey';
            columns: ['artifact_id'];
            isOneToOne: false;
            referencedRelation: 'artifacts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_comments_created_by_identity_id_fkey';
            columns: ['created_by_identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_comments_created_by_user_id_fkey';
            columns: ['created_by_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_comments_parent_comment_id_fkey';
            columns: ['parent_comment_id'];
            isOneToOne: false;
            referencedRelation: 'artifact_comments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_comments_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_comments_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      artifact_history: {
        Row: {
          artifact_id: string;
          change_summary: string | null;
          change_type: string | null;
          changed_by_identity_id: string | null;
          changed_by_user_id: string | null;
          content: string;
          created_at: string | null;
          id: string;
          title: string;
          version: number;
          workspace_id: string | null;
        };
        Insert: {
          artifact_id: string;
          change_summary?: string | null;
          change_type?: string | null;
          changed_by_identity_id?: string | null;
          changed_by_user_id?: string | null;
          content: string;
          created_at?: string | null;
          id?: string;
          title: string;
          version: number;
          workspace_id?: string | null;
        };
        Update: {
          artifact_id?: string;
          change_summary?: string | null;
          change_type?: string | null;
          changed_by_identity_id?: string | null;
          changed_by_user_id?: string | null;
          content?: string;
          created_at?: string | null;
          id?: string;
          title?: string;
          version?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'artifact_history_artifact_id_fkey';
            columns: ['artifact_id'];
            isOneToOne: false;
            referencedRelation: 'artifacts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_history_changed_by_identity_id_fkey';
            columns: ['changed_by_identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_history_changed_by_user_id_fkey';
            columns: ['changed_by_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifact_history_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      artifacts: {
        Row: {
          artifact_type: string;
          collaborators: string[] | null;
          content: string;
          content_type: string | null;
          created_at: string | null;
          created_by_identity_id: string | null;
          edit_mode: string;
          id: string;
          metadata: Json | null;
          tags: string[] | null;
          title: string;
          updated_at: string | null;
          uri: string;
          user_id: string;
          version: number | null;
          visibility: string | null;
          workspace_id: string | null;
        };
        Insert: {
          artifact_type?: string;
          collaborators?: string[] | null;
          content: string;
          content_type?: string | null;
          created_at?: string | null;
          created_by_identity_id?: string | null;
          edit_mode?: string;
          id?: string;
          metadata?: Json | null;
          tags?: string[] | null;
          title: string;
          updated_at?: string | null;
          uri: string;
          user_id: string;
          version?: number | null;
          visibility?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          artifact_type?: string;
          collaborators?: string[] | null;
          content?: string;
          content_type?: string | null;
          created_at?: string | null;
          created_by_identity_id?: string | null;
          edit_mode?: string;
          id?: string;
          metadata?: Json | null;
          tags?: string[] | null;
          title?: string;
          updated_at?: string | null;
          uri?: string;
          user_id?: string;
          version?: number | null;
          visibility?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'artifacts_created_by_identity_id_fkey';
            columns: ['created_by_identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifacts_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifacts_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      audit_log: {
        Row: {
          action: string;
          backend: string | null;
          category: string;
          conversation_id: string | null;
          id: string;
          metadata: Json | null;
          platform: string | null;
          platform_user_id: string | null;
          request_summary: string | null;
          response_status: string | null;
          response_summary: string | null;
          session_id: string | null;
          target: string | null;
          timestamp: string;
          user_id: string | null;
        };
        Insert: {
          action: string;
          backend?: string | null;
          category: string;
          conversation_id?: string | null;
          id?: string;
          metadata?: Json | null;
          platform?: string | null;
          platform_user_id?: string | null;
          request_summary?: string | null;
          response_status?: string | null;
          response_summary?: string | null;
          session_id?: string | null;
          target?: string | null;
          timestamp?: string;
          user_id?: string | null;
        };
        Update: {
          action?: string;
          backend?: string | null;
          category?: string;
          conversation_id?: string | null;
          id?: string;
          metadata?: Json | null;
          platform?: string | null;
          platform_user_id?: string | null;
          request_summary?: string | null;
          response_status?: string | null;
          response_summary?: string | null;
          session_id?: string | null;
          target?: string | null;
          timestamp?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_log_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      authorized_groups: {
        Row: {
          authorization_method: string | null;
          authorized_at: string | null;
          authorized_by: string | null;
          group_name: string | null;
          id: string;
          platform: string;
          platform_group_id: string;
          revoked_at: string | null;
          revoked_by: string | null;
          status: string;
          workspace_id: string | null;
        };
        Insert: {
          authorization_method?: string | null;
          authorized_at?: string | null;
          authorized_by?: string | null;
          group_name?: string | null;
          id?: string;
          platform: string;
          platform_group_id: string;
          revoked_at?: string | null;
          revoked_by?: string | null;
          status?: string;
          workspace_id?: string | null;
        };
        Update: {
          authorization_method?: string | null;
          authorized_at?: string | null;
          authorized_by?: string | null;
          group_name?: string | null;
          id?: string;
          platform?: string;
          platform_group_id?: string;
          revoked_at?: string | null;
          revoked_by?: string | null;
          status?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'authorized_groups_authorized_by_fkey';
            columns: ['authorized_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'authorized_groups_revoked_by_fkey';
            columns: ['revoked_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'authorized_groups_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      channel_routes: {
        Row: {
          chat_id: string | null;
          created_at: string;
          id: string;
          identity_id: string;
          is_active: boolean;
          metadata: Json;
          platform: string;
          platform_account_id: string | null;
          studio_hint: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          chat_id?: string | null;
          created_at?: string;
          id?: string;
          identity_id: string;
          is_active?: boolean;
          metadata?: Json;
          platform: string;
          platform_account_id?: string | null;
          studio_hint?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          chat_id?: string | null;
          created_at?: string;
          id?: string;
          identity_id?: string;
          is_active?: boolean;
          metadata?: Json;
          platform?: string;
          platform_account_id?: string | null;
          studio_hint?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'channel_routes_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'channel_routes_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      connected_accounts: {
        Row: {
          access_token: string;
          avatar_url: string | null;
          created_at: string | null;
          display_name: string | null;
          email: string | null;
          expires_at: string | null;
          id: string;
          last_error: string | null;
          last_used_at: string | null;
          metadata: Json | null;
          provider: string;
          provider_account_id: string;
          refresh_token: string | null;
          refresh_token_expires_at: string | null;
          scopes: string[] | null;
          status: string | null;
          token_type: string | null;
          updated_at: string | null;
          user_id: string;
          workspace_id: string | null;
        };
        Insert: {
          access_token: string;
          avatar_url?: string | null;
          created_at?: string | null;
          display_name?: string | null;
          email?: string | null;
          expires_at?: string | null;
          id?: string;
          last_error?: string | null;
          last_used_at?: string | null;
          metadata?: Json | null;
          provider: string;
          provider_account_id: string;
          refresh_token?: string | null;
          refresh_token_expires_at?: string | null;
          scopes?: string[] | null;
          status?: string | null;
          token_type?: string | null;
          updated_at?: string | null;
          user_id: string;
          workspace_id?: string | null;
        };
        Update: {
          access_token?: string;
          avatar_url?: string | null;
          created_at?: string | null;
          display_name?: string | null;
          email?: string | null;
          expires_at?: string | null;
          id?: string;
          last_error?: string | null;
          last_used_at?: string | null;
          metadata?: Json | null;
          provider?: string;
          provider_account_id?: string;
          refresh_token?: string | null;
          refresh_token_expires_at?: string | null;
          scopes?: string[] | null;
          status?: string | null;
          token_type?: string | null;
          updated_at?: string | null;
          user_id?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'connected_accounts_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'connected_accounts_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      contacts: {
        Row: {
          aliases: string[] | null;
          created_at: string | null;
          discord_id: string | null;
          display_name: string | null;
          email: string | null;
          id: string;
          imessage_id: string | null;
          name: string;
          notes: string | null;
          phone: string | null;
          tags: string[] | null;
          telegram_id: string | null;
          telegram_username: string | null;
          type: string;
          updated_at: string | null;
          user_id: string;
          whatsapp_id: string | null;
        };
        Insert: {
          aliases?: string[] | null;
          created_at?: string | null;
          discord_id?: string | null;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          imessage_id?: string | null;
          name: string;
          notes?: string | null;
          phone?: string | null;
          tags?: string[] | null;
          telegram_id?: string | null;
          telegram_username?: string | null;
          type?: string;
          updated_at?: string | null;
          user_id: string;
          whatsapp_id?: string | null;
        };
        Update: {
          aliases?: string[] | null;
          created_at?: string | null;
          discord_id?: string | null;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          imessage_id?: string | null;
          name?: string;
          notes?: string | null;
          phone?: string | null;
          tags?: string[] | null;
          telegram_id?: string | null;
          telegram_username?: string | null;
          type?: string;
          updated_at?: string | null;
          user_id?: string;
          whatsapp_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'contacts_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      context_history: {
        Row: {
          archived_at: string | null;
          change_type: string;
          context_id: string;
          context_key: string | null;
          context_type: string;
          created_at: string;
          id: string;
          metadata: Json | null;
          summary: string;
          user_id: string;
          version: number;
        };
        Insert: {
          archived_at?: string | null;
          change_type?: string;
          context_id: string;
          context_key?: string | null;
          context_type: string;
          created_at: string;
          id?: string;
          metadata?: Json | null;
          summary: string;
          user_id: string;
          version: number;
        };
        Update: {
          archived_at?: string | null;
          change_type?: string;
          context_id?: string;
          context_key?: string | null;
          context_type?: string;
          created_at?: string;
          id?: string;
          metadata?: Json | null;
          summary?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'context_history_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      context_summaries: {
        Row: {
          context_key: string | null;
          context_type: string;
          created_at: string | null;
          id: string;
          metadata: Json | null;
          summary: string;
          updated_at: string | null;
          user_id: string;
          version: number | null;
        };
        Insert: {
          context_key?: string | null;
          context_type: string;
          created_at?: string | null;
          id?: string;
          metadata?: Json | null;
          summary: string;
          updated_at?: string | null;
          user_id: string;
          version?: number | null;
        };
        Update: {
          context_key?: string | null;
          context_type?: string;
          created_at?: string | null;
          id?: string;
          metadata?: Json | null;
          summary?: string;
          updated_at?: string | null;
          user_id?: string;
          version?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'context_summaries_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      conversations: {
        Row: {
          created_at: string | null;
          id: string;
          metadata: Json | null;
          platform: string;
          platform_conversation_id: string;
          title: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          metadata?: Json | null;
          platform: string;
          platform_conversation_id: string;
          title?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          metadata?: Json | null;
          platform?: string;
          platform_conversation_id?: string;
          title?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'conversations_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      group_challenge_codes: {
        Row: {
          code: string;
          created_at: string | null;
          created_by: string | null;
          expires_at: string | null;
          id: string;
          used_at: string | null;
          used_for_group_id: string | null;
          used_for_platform: string | null;
          workspace_id: string | null;
        };
        Insert: {
          code: string;
          created_at?: string | null;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          used_at?: string | null;
          used_for_group_id?: string | null;
          used_for_platform?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          code?: string;
          created_at?: string | null;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          used_at?: string | null;
          used_for_group_id?: string | null;
          used_for_platform?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'group_challenge_codes_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'group_challenge_codes_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      heartbeat_state: {
        Row: {
          last_checks: Json | null;
          quiet_end: string | null;
          quiet_start: string | null;
          timezone: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          last_checks?: Json | null;
          quiet_end?: string | null;
          quiet_start?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          last_checks?: Json | null;
          quiet_end?: string | null;
          quiet_start?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'heartbeat_state_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      inbox_thread_messages: {
        Row: {
          content: string;
          created_at: string | null;
          id: string;
          message_type: string;
          metadata: Json | null;
          priority: string;
          sender_agent_id: string;
          thread_id: string;
        };
        Insert: {
          content: string;
          created_at?: string | null;
          id?: string;
          message_type?: string;
          metadata?: Json | null;
          priority?: string;
          sender_agent_id: string;
          thread_id: string;
        };
        Update: {
          content?: string;
          created_at?: string | null;
          id?: string;
          message_type?: string;
          metadata?: Json | null;
          priority?: string;
          sender_agent_id?: string;
          thread_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inbox_thread_messages_thread_id_fkey';
            columns: ['thread_id'];
            isOneToOne: false;
            referencedRelation: 'inbox_threads';
            referencedColumns: ['id'];
          },
        ];
      };
      inbox_thread_participants: {
        Row: {
          agent_id: string;
          joined_at: string | null;
          thread_id: string;
        };
        Insert: {
          agent_id: string;
          joined_at?: string | null;
          thread_id: string;
        };
        Update: {
          agent_id?: string;
          joined_at?: string | null;
          thread_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inbox_thread_participants_thread_id_fkey';
            columns: ['thread_id'];
            isOneToOne: false;
            referencedRelation: 'inbox_threads';
            referencedColumns: ['id'];
          },
        ];
      };
      inbox_thread_read_status: {
        Row: {
          agent_id: string;
          last_read_at: string | null;
          thread_id: string;
        };
        Insert: {
          agent_id: string;
          last_read_at?: string | null;
          thread_id: string;
        };
        Update: {
          agent_id?: string;
          last_read_at?: string | null;
          thread_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inbox_thread_read_status_thread_id_fkey';
            columns: ['thread_id'];
            isOneToOne: false;
            referencedRelation: 'inbox_threads';
            referencedColumns: ['id'];
          },
        ];
      };
      inbox_threads: {
        Row: {
          closed_at: string | null;
          closed_by_agent_id: string | null;
          created_at: string | null;
          created_by_agent_id: string;
          id: string;
          metadata: Json | null;
          status: string;
          thread_key: string;
          title: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          closed_at?: string | null;
          closed_by_agent_id?: string | null;
          created_at?: string | null;
          created_by_agent_id: string;
          id?: string;
          metadata?: Json | null;
          status?: string;
          thread_key: string;
          title?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          closed_at?: string | null;
          closed_by_agent_id?: string | null;
          created_at?: string | null;
          created_by_agent_id?: string;
          id?: string;
          metadata?: Json | null;
          status?: string;
          thread_key?: string;
          title?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inbox_threads_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      integration_health: {
        Row: {
          created_at: string | null;
          error_code: string | null;
          error_message: string | null;
          id: string;
          last_check_at: string | null;
          last_healthy_at: string | null;
          metadata: Json | null;
          reported_by_agent_id: string | null;
          service: string;
          status: string;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          last_check_at?: string | null;
          last_healthy_at?: string | null;
          metadata?: Json | null;
          reported_by_agent_id?: string | null;
          service: string;
          status?: string;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          last_check_at?: string | null;
          last_healthy_at?: string | null;
          metadata?: Json | null;
          reported_by_agent_id?: string | null;
          service?: string;
          status?: string;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'integration_health_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      links: {
        Row: {
          created_at: string | null;
          description: string | null;
          embedding: string | null;
          id: string;
          metadata: Json | null;
          source: string | null;
          tags: string[] | null;
          title: string | null;
          updated_at: string | null;
          url: string;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          description?: string | null;
          embedding?: string | null;
          id?: string;
          metadata?: Json | null;
          source?: string | null;
          tags?: string[] | null;
          title?: string | null;
          updated_at?: string | null;
          url: string;
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          description?: string | null;
          embedding?: string | null;
          id?: string;
          metadata?: Json | null;
          source?: string | null;
          tags?: string[] | null;
          title?: string | null;
          updated_at?: string | null;
          url?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'links_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      mcp_tokens: {
        Row: {
          agent_id: string | null;
          client_id: string;
          created_at: string | null;
          expires_at: string;
          id: string;
          identity_id: string | null;
          last_used_at: string | null;
          refresh_token: string;
          scopes: string[] | null;
          supabase_refresh_token: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          agent_id?: string | null;
          client_id: string;
          created_at?: string | null;
          expires_at: string;
          id?: string;
          identity_id?: string | null;
          last_used_at?: string | null;
          refresh_token: string;
          scopes?: string[] | null;
          supabase_refresh_token?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          agent_id?: string | null;
          client_id?: string;
          created_at?: string | null;
          expires_at?: string;
          id?: string;
          identity_id?: string | null;
          last_used_at?: string | null;
          refresh_token?: string;
          scopes?: string[] | null;
          supabase_refresh_token?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'mcp_tokens_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'mcp_tokens_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      memories: {
        Row: {
          agent_id: string | null;
          contact_id: string | null;
          content: string;
          created_at: string | null;
          embedding_chunk_count: number | null;
          embedding_chunks_version: number | null;
          embedding: string | null;
          expires_at: string | null;
          id: string;
          identity_id: string | null;
          metadata: Json | null;
          salience: string;
          source: string;
          summary: string | null;
          topic_key: string | null;
          topics: string[] | null;
          user_id: string;
          version: number;
        };
        Insert: {
          agent_id?: string | null;
          contact_id?: string | null;
          content: string;
          created_at?: string | null;
          embedding_chunk_count?: number | null;
          embedding_chunks_version?: number | null;
          embedding?: string | null;
          expires_at?: string | null;
          id?: string;
          identity_id?: string | null;
          metadata?: Json | null;
          salience?: string;
          source?: string;
          summary?: string | null;
          topic_key?: string | null;
          topics?: string[] | null;
          user_id: string;
          version?: number;
        };
        Update: {
          agent_id?: string | null;
          contact_id?: string | null;
          content?: string;
          created_at?: string | null;
          embedding_chunk_count?: number | null;
          embedding_chunks_version?: number | null;
          embedding?: string | null;
          expires_at?: string | null;
          id?: string;
          identity_id?: string | null;
          metadata?: Json | null;
          salience?: string;
          source?: string;
          summary?: string | null;
          topic_key?: string | null;
          topics?: string[] | null;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'memories_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memories_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_embedding_chunks: {
        Row: {
          chunk_index: number;
          chunk_text: string;
          chunk_type: string;
          created_at: string;
          embedding: string;
          id: string;
          memory_id: string;
          metadata: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          chunk_index: number;
          chunk_text: string;
          chunk_type?: string;
          created_at?: string;
          embedding: string;
          id?: string;
          memory_id: string;
          metadata?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          chunk_index?: number;
          chunk_text?: string;
          chunk_type?: string;
          created_at?: string;
          embedding?: string;
          id?: string;
          memory_id?: string;
          metadata?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_embedding_chunks_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memory_embedding_chunks_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_history: {
        Row: {
          archived_at: string | null;
          change_type: string;
          contact_id: string | null;
          content: string;
          created_at: string;
          id: string;
          memory_id: string;
          metadata: Json | null;
          salience: string;
          source: string;
          summary: string | null;
          topic_key: string | null;
          topics: string[] | null;
          user_id: string;
          version: number;
        };
        Insert: {
          archived_at?: string | null;
          change_type?: string;
          contact_id?: string | null;
          content: string;
          created_at: string;
          id?: string;
          memory_id: string;
          metadata?: Json | null;
          salience: string;
          source: string;
          summary?: string | null;
          topic_key?: string | null;
          topics?: string[] | null;
          user_id: string;
          version?: number;
        };
        Update: {
          archived_at?: string | null;
          change_type?: string;
          contact_id?: string | null;
          content?: string;
          created_at?: string;
          id?: string;
          memory_id?: string;
          metadata?: Json | null;
          salience?: string;
          source?: string;
          summary?: string | null;
          topic_key?: string | null;
          topics?: string[] | null;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_history_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_recall_benchmark_case_results: {
        Row: {
          case_id: string;
          created_at: string;
          id: string;
          mode: string;
          query: string;
          rank: number | null;
          run_id: string;
          top_summaries: Json;
        };
        Insert: {
          case_id: string;
          created_at?: string;
          id?: string;
          mode: string;
          query: string;
          rank?: number | null;
          run_id: string;
          top_summaries?: Json;
        };
        Update: {
          case_id?: string;
          created_at?: string;
          id?: string;
          mode?: string;
          query?: string;
          rank?: number | null;
          run_id?: string;
          top_summaries?: Json;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_recall_benchmark_case_results_run_id_fkey';
            columns: ['run_id'];
            isOneToOne: false;
            referencedRelation: 'memory_recall_benchmark_runs';
            referencedColumns: ['run_id'];
          },
        ];
      };
      memory_recall_benchmark_metrics: {
        Row: {
          cases: number;
          created_at: string;
          id: string;
          mode: string;
          mrr: number;
          recall_at_1: number;
          recall_at_3: number;
          recall_at_5: number;
          run_id: string;
        };
        Insert: {
          cases: number;
          created_at?: string;
          id?: string;
          mode: string;
          mrr: number;
          recall_at_1: number;
          recall_at_3: number;
          recall_at_5: number;
          run_id: string;
        };
        Update: {
          cases?: number;
          created_at?: string;
          id?: string;
          mode?: string;
          mrr?: number;
          recall_at_1?: number;
          recall_at_3?: number;
          recall_at_5?: number;
          run_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_recall_benchmark_metrics_run_id_fkey';
            columns: ['run_id'];
            isOneToOne: false;
            referencedRelation: 'memory_recall_benchmark_runs';
            referencedColumns: ['run_id'];
          },
        ];
      };
      memory_recall_benchmark_runs: {
        Row: {
          case_count: number;
          created_at: string;
          dataset: string;
          embeddings_enabled: boolean;
          id: string;
          metadata: Json;
          model: string;
          modes: string[];
          provider: string;
          run_id: string;
          summary: Json;
          top_k: number;
          user_id: string;
        };
        Insert: {
          case_count?: number;
          created_at?: string;
          dataset: string;
          embeddings_enabled?: boolean;
          id?: string;
          metadata?: Json;
          model: string;
          modes?: string[];
          provider: string;
          run_id: string;
          summary?: Json;
          top_k?: number;
          user_id: string;
        };
        Update: {
          case_count?: number;
          created_at?: string;
          dataset?: string;
          embeddings_enabled?: boolean;
          id?: string;
          metadata?: Json;
          model?: string;
          modes?: string[];
          provider?: string;
          run_id?: string;
          summary?: Json;
          top_k?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_recall_benchmark_runs_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_summary_cache: {
        Row: {
          agent_id: string;
          computed_at: string;
          memory_count: number;
          summary_text: string;
          user_id: string;
        };
        Insert: {
          agent_id?: string;
          computed_at?: string;
          memory_count?: number;
          summary_text: string;
          user_id: string;
        };
        Update: {
          agent_id?: string;
          computed_at?: string;
          memory_count?: number;
          summary_text?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_summary_cache_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      messages: {
        Row: {
          content: string;
          conversation_id: string;
          created_at: string | null;
          embedding: string | null;
          id: string;
          message_type: string | null;
          metadata: Json | null;
          platform_message_id: string | null;
          user_id: string;
        };
        Insert: {
          content: string;
          conversation_id: string;
          created_at?: string | null;
          embedding?: string | null;
          id?: string;
          message_type?: string | null;
          metadata?: Json | null;
          platform_message_id?: string | null;
          user_id: string;
        };
        Update: {
          content?: string;
          conversation_id?: string;
          created_at?: string | null;
          embedding?: string | null;
          id?: string;
          message_type?: string | null;
          metadata?: Json | null;
          platform_message_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'messages_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      mini_app_records: {
        Row: {
          amount: number | null;
          app_name: string;
          contact_id: string | null;
          created_at: string;
          data: Json;
          id: string;
          metadata: Json | null;
          recorded_at: string | null;
          related_entity_id: string | null;
          related_entity_type: string | null;
          related_record_id: string | null;
          tags: string[] | null;
          text: string | null;
          type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          amount?: number | null;
          app_name: string;
          contact_id?: string | null;
          created_at?: string;
          data?: Json;
          id?: string;
          metadata?: Json | null;
          recorded_at?: string | null;
          related_entity_id?: string | null;
          related_entity_type?: string | null;
          related_record_id?: string | null;
          tags?: string[] | null;
          text?: string | null;
          type: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          amount?: number | null;
          app_name?: string;
          contact_id?: string | null;
          created_at?: string;
          data?: Json;
          id?: string;
          metadata?: Json | null;
          recorded_at?: string | null;
          related_entity_id?: string | null;
          related_entity_type?: string | null;
          related_record_id?: string | null;
          tags?: string[] | null;
          text?: string | null;
          type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'mini_app_records_contact_id_fkey';
            columns: ['contact_id'];
            isOneToOne: false;
            referencedRelation: 'contacts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'mini_app_records_related_record_id_fkey';
            columns: ['related_record_id'];
            isOneToOne: false;
            referencedRelation: 'mini_app_records';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'mini_app_records_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      notes: {
        Row: {
          content: string;
          created_at: string | null;
          embedding: string | null;
          id: string;
          is_private: boolean | null;
          metadata: Json | null;
          tags: string[] | null;
          title: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          content: string;
          created_at?: string | null;
          embedding?: string | null;
          id?: string;
          is_private?: boolean | null;
          metadata?: Json | null;
          tags?: string[] | null;
          title?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          content?: string;
          created_at?: string | null;
          embedding?: string | null;
          id?: string;
          is_private?: boolean | null;
          metadata?: Json | null;
          tags?: string[] | null;
          title?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notes_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      pcp_config: {
        Row: {
          key: string;
          updated_at: string | null;
          value: string;
        };
        Insert: {
          key: string;
          updated_at?: string | null;
          value: string;
        };
        Update: {
          key?: string;
          updated_at?: string | null;
          value?: string;
        };
        Relationships: [];
      };
      permission_definitions: {
        Row: {
          category: string;
          created_at: string | null;
          default_enabled: boolean | null;
          description: string | null;
          id: string;
          name: string;
          risk_level: string;
        };
        Insert: {
          category: string;
          created_at?: string | null;
          default_enabled?: boolean | null;
          description?: string | null;
          id: string;
          name: string;
          risk_level?: string;
        };
        Update: {
          category?: string;
          created_at?: string | null;
          default_enabled?: boolean | null;
          description?: string | null;
          id?: string;
          name?: string;
          risk_level?: string;
        };
        Relationships: [];
      };
      projects: {
        Row: {
          created_at: string | null;
          description: string | null;
          goals: string[] | null;
          id: string;
          metadata: Json | null;
          name: string;
          repository_url: string | null;
          status: string | null;
          tech_stack: string[] | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          description?: string | null;
          goals?: string[] | null;
          id?: string;
          metadata?: Json | null;
          name: string;
          repository_url?: string | null;
          status?: string | null;
          tech_stack?: string[] | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          description?: string | null;
          goals?: string[] | null;
          id?: string;
          metadata?: Json | null;
          name?: string;
          repository_url?: string | null;
          status?: string | null;
          tech_stack?: string[] | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'projects_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      reminder_history: {
        Row: {
          delivered_at: string | null;
          error_message: string | null;
          id: string;
          reminder_id: string;
          response_at: string | null;
          response_content: string | null;
          response_received: boolean | null;
          status: string;
          triggered_at: string | null;
        };
        Insert: {
          delivered_at?: string | null;
          error_message?: string | null;
          id?: string;
          reminder_id: string;
          response_at?: string | null;
          response_content?: string | null;
          response_received?: boolean | null;
          status: string;
          triggered_at?: string | null;
        };
        Update: {
          delivered_at?: string | null;
          error_message?: string | null;
          id?: string;
          reminder_id?: string;
          response_at?: string | null;
          response_content?: string | null;
          response_received?: boolean | null;
          status?: string;
          triggered_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'reminder_history_reminder_id_fkey';
            columns: ['reminder_id'];
            isOneToOne: false;
            referencedRelation: 'scheduled_reminders';
            referencedColumns: ['id'];
          },
        ];
      };
      reminders: {
        Row: {
          channel: string;
          created_at: string | null;
          id: string;
          message: string;
          metadata: Json | null;
          recurrence: Json | null;
          reminder_time: string;
          sent_at: string | null;
          status: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          channel: string;
          created_at?: string | null;
          id?: string;
          message: string;
          metadata?: Json | null;
          recurrence?: Json | null;
          reminder_time: string;
          sent_at?: string | null;
          status?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          channel?: string;
          created_at?: string | null;
          id?: string;
          message?: string;
          metadata?: Json | null;
          recurrence?: Json | null;
          reminder_time?: string;
          sent_at?: string | null;
          status?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'reminders_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      scheduled_reminders: {
        Row: {
          created_at: string | null;
          cron_expression: string | null;
          delivery_channel: string;
          delivery_target: string | null;
          description: string | null;
          id: string;
          identity_id: string | null;
          last_run_at: string | null;
          max_runs: number | null;
          metadata: Json | null;
          next_run_at: string;
          run_count: number | null;
          status: string;
          studio_hint: string | null;
          title: string;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          cron_expression?: string | null;
          delivery_channel?: string;
          delivery_target?: string | null;
          description?: string | null;
          id?: string;
          identity_id?: string | null;
          last_run_at?: string | null;
          max_runs?: number | null;
          metadata?: Json | null;
          next_run_at: string;
          run_count?: number | null;
          status?: string;
          studio_hint?: string | null;
          title: string;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          cron_expression?: string | null;
          delivery_channel?: string;
          delivery_target?: string | null;
          description?: string | null;
          id?: string;
          identity_id?: string | null;
          last_run_at?: string | null;
          max_runs?: number | null;
          metadata?: Json | null;
          next_run_at?: string;
          run_count?: number | null;
          status?: string;
          studio_hint?: string | null;
          title?: string;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scheduled_reminders_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'scheduled_reminders_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      session_focus: {
        Row: {
          context_snapshot: Json | null;
          created_at: string | null;
          focus_summary: string | null;
          id: string;
          project_id: string | null;
          session_id: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          context_snapshot?: Json | null;
          created_at?: string | null;
          focus_summary?: string | null;
          id?: string;
          project_id?: string | null;
          session_id?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          context_snapshot?: Json | null;
          created_at?: string | null;
          focus_summary?: string | null;
          id?: string;
          project_id?: string | null;
          session_id?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'session_focus_project_id_fkey';
            columns: ['project_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'session_focus_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      session_logs: {
        Row: {
          compacted_at: string | null;
          compacted_into_memory_id: string | null;
          content: string;
          created_at: string | null;
          id: string;
          salience: string;
          session_id: string;
        };
        Insert: {
          compacted_at?: string | null;
          compacted_into_memory_id?: string | null;
          content: string;
          created_at?: string | null;
          id?: string;
          salience?: string;
          session_id: string;
        };
        Update: {
          compacted_at?: string | null;
          compacted_into_memory_id?: string | null;
          content?: string;
          created_at?: string | null;
          id?: string;
          salience?: string;
          session_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'session_logs_compacted_into_memory_id_fkey';
            columns: ['compacted_into_memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'session_logs_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'sessions';
            referencedColumns: ['id'];
          },
        ];
      };
      session_transcript_archives: {
        Row: {
          backend: string | null;
          backend_session_id: string | null;
          byte_count: number;
          created_at: string;
          id: string;
          line_count: number;
          payload: Json;
          session_id: string;
          source_path: string | null;
          synced_at: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          backend?: string | null;
          backend_session_id?: string | null;
          byte_count?: number;
          created_at?: string;
          id?: string;
          line_count?: number;
          payload: Json;
          session_id: string;
          source_path?: string | null;
          synced_at?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          backend?: string | null;
          backend_session_id?: string | null;
          byte_count?: number;
          created_at?: string;
          id?: string;
          line_count?: number;
          payload?: Json;
          session_id?: string;
          source_path?: string | null;
          synced_at?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'session_transcript_archives_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'session_transcript_archives_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      sessions: {
        Row: {
          agent_id: string | null;
          backend: string | null;
          backend_session_id: string | null;
          claude_session_id: string | null;
          compacting_since: string | null;
          contact_id: string | null;
          context: string | null;
          current_phase: string | null;
          ended_at: string | null;
          id: string;
          identity_id: string | null;
          lifecycle: string | null;
          message_count: number | null;
          metadata: Json | null;
          model: string | null;
          started_at: string | null;
          status: string | null;
          studio_id: string | null;
          summary: string | null;
          thread_key: string | null;
          token_count: number | null;
          updated_at: string | null;
          user_id: string;
          working_dir: string | null;
          workspace_id: string | null;
        };
        Insert: {
          agent_id?: string | null;
          backend?: string | null;
          backend_session_id?: string | null;
          claude_session_id?: string | null;
          compacting_since?: string | null;
          contact_id?: string | null;
          context?: string | null;
          current_phase?: string | null;
          ended_at?: string | null;
          id?: string;
          identity_id?: string | null;
          lifecycle?: string | null;
          message_count?: number | null;
          metadata?: Json | null;
          model?: string | null;
          started_at?: string | null;
          status?: string | null;
          studio_id?: string | null;
          summary?: string | null;
          thread_key?: string | null;
          token_count?: number | null;
          updated_at?: string | null;
          user_id: string;
          working_dir?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          agent_id?: string | null;
          backend?: string | null;
          backend_session_id?: string | null;
          claude_session_id?: string | null;
          compacting_since?: string | null;
          contact_id?: string | null;
          context?: string | null;
          current_phase?: string | null;
          ended_at?: string | null;
          id?: string;
          identity_id?: string | null;
          lifecycle?: string | null;
          message_count?: number | null;
          metadata?: Json | null;
          model?: string | null;
          started_at?: string | null;
          status?: string | null;
          studio_id?: string | null;
          summary?: string | null;
          thread_key?: string | null;
          token_count?: number | null;
          updated_at?: string | null;
          user_id?: string;
          working_dir?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'sessions_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sessions_studio_id_fkey';
            columns: ['studio_id'];
            isOneToOne: false;
            referencedRelation: 'studios';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sessions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sessions_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'studios';
            referencedColumns: ['id'];
          },
        ];
      };
      skill_installations: {
        Row: {
          config: Json | null;
          enabled: boolean | null;
          id: string;
          installed_at: string | null;
          last_used_at: string | null;
          skill_id: string;
          usage_count: number | null;
          user_id: string;
          version_pinned: string | null;
        };
        Insert: {
          config?: Json | null;
          enabled?: boolean | null;
          id?: string;
          installed_at?: string | null;
          last_used_at?: string | null;
          skill_id: string;
          usage_count?: number | null;
          user_id: string;
          version_pinned?: string | null;
        };
        Update: {
          config?: Json | null;
          enabled?: boolean | null;
          id?: string;
          installed_at?: string | null;
          last_used_at?: string | null;
          skill_id?: string;
          usage_count?: number | null;
          user_id?: string;
          version_pinned?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'skill_installations_skill_id_fkey';
            columns: ['skill_id'];
            isOneToOne: false;
            referencedRelation: 'skills';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'skill_installations_skill_id_fkey';
            columns: ['skill_id'];
            isOneToOne: false;
            referencedRelation: 'user_installed_skills';
            referencedColumns: ['skill_id'];
          },
          {
            foreignKeyName: 'skill_installations_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      skill_versions: {
        Row: {
          changelog: string | null;
          content: string;
          id: string;
          manifest: Json;
          published_at: string | null;
          published_by: string | null;
          skill_id: string;
          version: string;
        };
        Insert: {
          changelog?: string | null;
          content?: string;
          id?: string;
          manifest?: Json;
          published_at?: string | null;
          published_by?: string | null;
          skill_id: string;
          version: string;
        };
        Update: {
          changelog?: string | null;
          content?: string;
          id?: string;
          manifest?: Json;
          published_at?: string | null;
          published_by?: string | null;
          skill_id?: string;
          version?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'skill_versions_published_by_fkey';
            columns: ['published_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'skill_versions_skill_id_fkey';
            columns: ['skill_id'];
            isOneToOne: false;
            referencedRelation: 'skills';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'skill_versions_skill_id_fkey';
            columns: ['skill_id'];
            isOneToOne: false;
            referencedRelation: 'user_installed_skills';
            referencedColumns: ['skill_id'];
          },
        ];
      };
      skills: {
        Row: {
          author: string | null;
          author_user_id: string | null;
          category: string | null;
          content: string;
          created_at: string | null;
          current_version: string;
          deprecated_at: string | null;
          deprecated_by: string | null;
          deprecation_message: string | null;
          description: string;
          display_name: string;
          emoji: string | null;
          forked_from_id: string | null;
          homepage_url: string | null;
          id: string;
          install_count: number | null;
          is_official: boolean | null;
          is_public: boolean | null;
          is_verified: boolean | null;
          last_published_by: string | null;
          manifest: Json;
          name: string;
          published_at: string | null;
          repository_url: string | null;
          status: string | null;
          tags: string[] | null;
          type: string;
          updated_at: string | null;
        };
        Insert: {
          author?: string | null;
          author_user_id?: string | null;
          category?: string | null;
          content?: string;
          created_at?: string | null;
          current_version?: string;
          deprecated_at?: string | null;
          deprecated_by?: string | null;
          deprecation_message?: string | null;
          description: string;
          display_name: string;
          emoji?: string | null;
          forked_from_id?: string | null;
          homepage_url?: string | null;
          id?: string;
          install_count?: number | null;
          is_official?: boolean | null;
          is_public?: boolean | null;
          is_verified?: boolean | null;
          last_published_by?: string | null;
          manifest?: Json;
          name: string;
          published_at?: string | null;
          repository_url?: string | null;
          status?: string | null;
          tags?: string[] | null;
          type: string;
          updated_at?: string | null;
        };
        Update: {
          author?: string | null;
          author_user_id?: string | null;
          category?: string | null;
          content?: string;
          created_at?: string | null;
          current_version?: string;
          deprecated_at?: string | null;
          deprecated_by?: string | null;
          deprecation_message?: string | null;
          description?: string;
          display_name?: string;
          emoji?: string | null;
          forked_from_id?: string | null;
          homepage_url?: string | null;
          id?: string;
          install_count?: number | null;
          is_official?: boolean | null;
          is_public?: boolean | null;
          is_verified?: boolean | null;
          last_published_by?: string | null;
          manifest?: Json;
          name?: string;
          published_at?: string | null;
          repository_url?: string | null;
          status?: string | null;
          tags?: string[] | null;
          type?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'skills_author_user_id_fkey';
            columns: ['author_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'skills_deprecated_by_fkey';
            columns: ['deprecated_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'skills_forked_from_id_fkey';
            columns: ['forked_from_id'];
            isOneToOne: false;
            referencedRelation: 'skills';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'skills_forked_from_id_fkey';
            columns: ['forked_from_id'];
            isOneToOne: false;
            referencedRelation: 'user_installed_skills';
            referencedColumns: ['skill_id'];
          },
          {
            foreignKeyName: 'skills_last_published_by_fkey';
            columns: ['last_published_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      studios: {
        Row: {
          agent_id: string | null;
          archived_at: string | null;
          base_branch: string | null;
          branch: string;
          cleaned_at: string | null;
          created_at: string | null;
          id: string;
          identity_id: string | null;
          metadata: Json | null;
          permissions: Json;
          purpose: string | null;
          repo_root: string;
          role_template: string | null;
          session_id: string | null;
          slug: string | null;
          status: string;
          updated_at: string | null;
          user_id: string;
          work_type: string | null;
          worktree_path: string;
        };
        Insert: {
          agent_id?: string | null;
          archived_at?: string | null;
          base_branch?: string | null;
          branch: string;
          cleaned_at?: string | null;
          created_at?: string | null;
          id?: string;
          identity_id?: string | null;
          metadata?: Json | null;
          permissions?: Json;
          purpose?: string | null;
          repo_root: string;
          role_template?: string | null;
          session_id?: string | null;
          slug?: string | null;
          status?: string;
          updated_at?: string | null;
          user_id: string;
          work_type?: string | null;
          worktree_path: string;
        };
        Update: {
          agent_id?: string | null;
          archived_at?: string | null;
          base_branch?: string | null;
          branch?: string;
          cleaned_at?: string | null;
          created_at?: string | null;
          id?: string;
          identity_id?: string | null;
          metadata?: Json | null;
          permissions?: Json;
          purpose?: string | null;
          repo_root?: string;
          role_template?: string | null;
          session_id?: string | null;
          slug?: string | null;
          status?: string;
          updated_at?: string | null;
          user_id?: string;
          work_type?: string | null;
          worktree_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'studios_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'studios_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'studios_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      task_groups: {
        Row: {
          autonomous: boolean;
          context_summary: string | null;
          created_at: string;
          description: string | null;
          id: string;
          identity_id: string | null;
          max_sessions: number | null;
          metadata: Json;
          next_run_after: string | null;
          output_status: string | null;
          output_target: string | null;
          priority: string;
          project_id: string | null;
          sessions_used: number;
          status: string;
          tags: string[];
          thread_key: string | null;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          autonomous?: boolean;
          context_summary?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          identity_id?: string | null;
          max_sessions?: number | null;
          metadata?: Json;
          next_run_after?: string | null;
          output_status?: string | null;
          output_target?: string | null;
          priority?: string;
          project_id?: string | null;
          sessions_used?: number;
          status?: string;
          tags?: string[];
          thread_key?: string | null;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          autonomous?: boolean;
          context_summary?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          identity_id?: string | null;
          max_sessions?: number | null;
          metadata?: Json;
          next_run_after?: string | null;
          output_status?: string | null;
          output_target?: string | null;
          priority?: string;
          project_id?: string | null;
          sessions_used?: number;
          status?: string;
          tags?: string[];
          thread_key?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'task_groups_identity_id_fkey';
            columns: ['identity_id'];
            isOneToOne: false;
            referencedRelation: 'agent_identities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'task_groups_project_id_fkey';
            columns: ['project_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'task_groups_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      tasks: {
        Row: {
          blocked_by: string[] | null;
          completed_at: string | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          due_date: string | null;
          id: string;
          metadata: Json;
          priority: string | null;
          project_id: string | null;
          status: string;
          tags: string[] | null;
          task_group_id: string | null;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          blocked_by?: string[] | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          due_date?: string | null;
          id?: string;
          metadata?: Json;
          priority?: string | null;
          project_id?: string | null;
          status?: string;
          tags?: string[] | null;
          task_group_id?: string | null;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          blocked_by?: string[] | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          due_date?: string | null;
          id?: string;
          metadata?: Json;
          priority?: string | null;
          project_id?: string | null;
          status?: string;
          tags?: string[] | null;
          task_group_id?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tasks_project_id_fkey';
            columns: ['project_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tasks_task_group_id_fkey';
            columns: ['task_group_id'];
            isOneToOne: false;
            referencedRelation: 'task_groups';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tasks_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      trusted_users: {
        Row: {
          added_at: string | null;
          added_by: string | null;
          id: string;
          platform: string;
          platform_user_id: string;
          trust_level: Database['public']['Enums']['trust_level'];
          user_id: string | null;
          workspace_id: string | null;
        };
        Insert: {
          added_at?: string | null;
          added_by?: string | null;
          id?: string;
          platform: string;
          platform_user_id: string;
          trust_level?: Database['public']['Enums']['trust_level'];
          user_id?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          added_at?: string | null;
          added_by?: string | null;
          id?: string;
          platform?: string;
          platform_user_id?: string;
          trust_level?: Database['public']['Enums']['trust_level'];
          user_id?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'trusted_users_added_by_fkey';
            columns: ['added_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'trusted_users_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'trusted_users_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      user_identity: {
        Row: {
          created_at: string | null;
          id: string;
          process_md: string | null;
          shared_values_md: string | null;
          updated_at: string | null;
          user_id: string;
          user_profile_md: string | null;
          version: number | null;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          process_md?: string | null;
          shared_values_md?: string | null;
          updated_at?: string | null;
          user_id: string;
          user_profile_md?: string | null;
          version?: number | null;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          process_md?: string | null;
          shared_values_md?: string | null;
          updated_at?: string | null;
          user_id?: string;
          user_profile_md?: string | null;
          version?: number | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'user_identity_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_identity_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      user_identity_history: {
        Row: {
          archived_at: string | null;
          change_type: string;
          created_at: string;
          id: string;
          identity_id: string;
          process_md: string | null;
          shared_values_md: string | null;
          user_id: string;
          user_profile_md: string | null;
          version: number;
          workspace_id: string | null;
        };
        Insert: {
          archived_at?: string | null;
          change_type?: string;
          created_at: string;
          id?: string;
          identity_id: string;
          process_md?: string | null;
          shared_values_md?: string | null;
          user_id: string;
          user_profile_md?: string | null;
          version: number;
          workspace_id?: string | null;
        };
        Update: {
          archived_at?: string | null;
          change_type?: string;
          created_at?: string;
          id?: string;
          identity_id?: string;
          process_md?: string | null;
          shared_values_md?: string | null;
          user_id?: string;
          user_profile_md?: string | null;
          version?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'user_identity_history_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_identity_history_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      user_permissions: {
        Row: {
          enabled: boolean;
          expires_at: string | null;
          granted_at: string | null;
          granted_by: string | null;
          id: string;
          permission_id: string;
          reason: string | null;
          user_id: string;
        };
        Insert: {
          enabled: boolean;
          expires_at?: string | null;
          granted_at?: string | null;
          granted_by?: string | null;
          id?: string;
          permission_id: string;
          reason?: string | null;
          user_id: string;
        };
        Update: {
          enabled?: boolean;
          expires_at?: string | null;
          granted_at?: string | null;
          granted_by?: string | null;
          id?: string;
          permission_id?: string;
          reason?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_permissions_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_permissions_permission_id_fkey';
            columns: ['permission_id'];
            isOneToOne: false;
            referencedRelation: 'permission_definitions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_permissions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      users: {
        Row: {
          created_at: string | null;
          discord_id: string | null;
          email: string | null;
          first_name: string | null;
          id: string;
          last_login_at: string | null;
          last_name: string | null;
          phone_number: string | null;
          preferences: Json | null;
          slack_id: string | null;
          telegram_id: number | null;
          telegram_username: string | null;
          timezone: string | null;
          updated_at: string | null;
          username: string | null;
          whatsapp_id: string | null;
        };
        Insert: {
          created_at?: string | null;
          discord_id?: string | null;
          email?: string | null;
          first_name?: string | null;
          id?: string;
          last_login_at?: string | null;
          last_name?: string | null;
          phone_number?: string | null;
          preferences?: Json | null;
          slack_id?: string | null;
          telegram_id?: number | null;
          telegram_username?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
          username?: string | null;
          whatsapp_id?: string | null;
        };
        Update: {
          created_at?: string | null;
          discord_id?: string | null;
          email?: string | null;
          first_name?: string | null;
          id?: string;
          last_login_at?: string | null;
          last_name?: string | null;
          phone_number?: string | null;
          preferences?: Json | null;
          slack_id?: string | null;
          telegram_id?: number | null;
          telegram_username?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
          username?: string | null;
          whatsapp_id?: string | null;
        };
        Relationships: [];
      };
      workspace_members: {
        Row: {
          created_at: string | null;
          id: string;
          role: string;
          user_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          role?: string;
          user_id: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          role?: string;
          user_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workspace_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'workspace_members_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      workspaces: {
        Row: {
          archived_at: string | null;
          created_at: string | null;
          description: string | null;
          id: string;
          metadata: Json | null;
          name: string;
          process: string | null;
          shared_values: string | null;
          slug: string;
          type: string;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          archived_at?: string | null;
          created_at?: string | null;
          description?: string | null;
          id?: string;
          metadata?: Json | null;
          name: string;
          process?: string | null;
          shared_values?: string | null;
          slug: string;
          type?: string;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string | null;
          description?: string | null;
          id?: string;
          metadata?: Json | null;
          name?: string;
          process?: string | null;
          shared_values?: string | null;
          slug?: string;
          type?: string;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workspaces_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      user_installed_skills: {
        Row: {
          author: string | null;
          category: string | null;
          content: string | null;
          current_version: string | null;
          description: string | null;
          display_name: string | null;
          emoji: string | null;
          enabled: boolean | null;
          installation_id: string | null;
          installed_at: string | null;
          is_official: boolean | null;
          is_verified: boolean | null;
          last_used_at: string | null;
          manifest: Json | null;
          name: string | null;
          repository_url: string | null;
          resolved_content: string | null;
          resolved_manifest: Json | null;
          resolved_version: string | null;
          skill_id: string | null;
          tags: string[] | null;
          type: string | null;
          usage_count: number | null;
          user_config: Json | null;
          user_id: string | null;
          version_pinned: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'skill_installations_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      match_links: {
        Args: {
          match_count?: number;
          match_threshold?: number;
          p_user_id?: string;
          query_embedding: string;
        };
        Returns: {
          description: string;
          id: string;
          similarity: number;
          tags: string[];
          title: string;
          url: string;
        }[];
      };
      match_memories: {
        Args: {
          match_count?: number;
          match_threshold?: number;
          p_agent_id?: string;
          p_include_expired?: boolean;
          p_include_shared?: boolean;
          p_salience?: string;
          p_source?: string;
          p_topics?: string[];
          p_user_id?: string;
          query_embedding: string;
        };
        Returns: {
          agent_id: string;
          content: string;
          created_at: string;
          embedding: string;
          expires_at: string;
          id: string;
          identity_id: string;
          metadata: Json;
          salience: string;
          similarity: number;
          source: string;
          summary: string;
          topic_key: string;
          topics: string[];
          user_id: string;
          version: number;
        }[];
      };
      match_memory_embedding_chunks: {
        Args: {
          match_count?: number;
          match_threshold?: number;
          p_agent_id?: string;
          p_include_expired?: boolean;
          p_include_shared?: boolean;
          p_salience?: string;
          p_source?: string;
          p_topics?: string[];
          p_user_id?: string;
          query_embedding: string;
        };
        Returns: {
          agent_id: string;
          content: string;
          created_at: string;
          embedding: string;
          expires_at: string;
          id: string;
          identity_id: string;
          matched_chunk_index: number;
          matched_chunk_text: string;
          metadata: Json;
          salience: string;
          similarity: number;
          source: string;
          summary: string;
          topic_key: string;
          topics: string[];
          user_id: string;
          version: number;
        }[];
      };
      match_messages: {
        Args: {
          match_count?: number;
          match_threshold?: number;
          p_user_id?: string;
          query_embedding: string;
        };
        Returns: {
          content: string;
          conversation_id: string;
          created_at: string;
          id: string;
          similarity: number;
        }[];
      };
      match_notes: {
        Args: {
          match_count?: number;
          match_threshold?: number;
          p_user_id?: string;
          query_embedding: string;
        };
        Returns: {
          content: string;
          id: string;
          similarity: number;
          tags: string[];
          title: string;
        }[];
      };
      show_limit: { Args: never; Returns: number };
      show_trgm: { Args: { '': string }; Returns: string[] };
      trigger_heartbeat: { Args: never; Returns: undefined };
    };
    Enums: {
      activity_type:
        | 'message_in'
        | 'message_out'
        | 'tool_call'
        | 'tool_result'
        | 'agent_spawn'
        | 'agent_complete'
        | 'state_change'
        | 'thinking'
        | 'error';
      trust_level: 'owner' | 'admin' | 'member';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      activity_type: [
        'message_in',
        'message_out',
        'tool_call',
        'tool_result',
        'agent_spawn',
        'agent_complete',
        'state_change',
        'thinking',
        'error',
      ],
      trust_level: ['owner', 'admin', 'member'],
    },
  },
} as const;
