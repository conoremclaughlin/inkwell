/**
 * Unified Skill Types
 *
 * Future-proof skill system supporting multiple skill types:
 * - mini-app: Code-based skills with functions (e.g., bill-split)
 * - cli: External CLI tools (e.g., gh, aws, gcloud)
 * - guide: Markdown-based guides for handling situations (e.g., group chat etiquette)
 */

// ============================================================================
// Skill Types
// ============================================================================

export type SkillType = 'mini-app' | 'cli' | 'guide';

export type SkillStatus = 'available' | 'installed' | 'needs-setup' | 'disabled';

// ============================================================================
// Installation & Requirements (inspired by Clawdbot)
// ============================================================================

export type InstallKind = 'brew' | 'npm' | 'pip' | 'go' | 'cargo' | 'manual' | 'builtin';

export interface InstallSpec {
  kind: InstallKind;
  /** Package/formula name */
  package?: string;
  /** For brew: formula name */
  formula?: string;
  /** Binary names this installs */
  bins?: string[];
  /** For npm: global vs local */
  global?: boolean;
  /** For manual: URL to download */
  url?: string;
  /** Installation instructions for manual */
  instructions?: string;
}

export interface RequirementsSpec {
  /** Required binaries (all must exist) */
  bins?: string[];
  /** Alternative binaries (at least one must exist) */
  anyBins?: string[];
  /** Required environment variables */
  env?: string[];
  /** Required config files */
  config?: string[];
  /** Supported operating systems */
  os?: Array<'macos' | 'linux' | 'windows'>;
  /** Minimum version requirements */
  versions?: Record<string, string>;
}

export interface EligibilityResult {
  eligible: boolean;
  missingBins?: string[];
  missingEnv?: string[];
  missingConfig?: string[];
  unsupportedOs?: boolean;
  message?: string;
}

// ============================================================================
// Skill Manifest (unified format)
// ============================================================================

export interface SkillManifest {
  /** Unique identifier (lowercase, hyphens) */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable display name */
  displayName?: string;
  /** Short description */
  description: string;
  /** Skill type */
  type: SkillType;
  /** Visual identifier */
  emoji?: string;
  /** Category for organization */
  category?: string;
  /** Tags for search */
  tags?: string[];
  /** Author/maintainer */
  author?: string;
  /** Documentation URL */
  homepage?: string;
  /** Repository URL */
  repository?: string;

  // ---- Triggers (when to suggest this skill) ----
  triggers?: {
    /** Keywords that suggest this skill */
    keywords?: string[];
    /** Intent identifiers */
    intents?: string[];
    /** Regex patterns */
    patterns?: string[];
    /** Always include in prompts */
    always?: boolean;
  };

  // ---- Capabilities (what the skill can do) ----
  capabilities?: {
    /** Can process images */
    vision?: boolean;
    /** Uses persistent memory */
    memory?: boolean;
    /** Makes external API calls */
    network?: boolean;
    /** Accesses file system */
    filesystem?: boolean;
    /** Runs shell commands */
    shell?: boolean;
  };

  // ---- Requirements & Installation ----
  requirements?: RequirementsSpec;
  install?: InstallSpec[];

  // ---- Type-specific configuration ----

  /** For mini-app: function definitions */
  functions?: SkillFunction[];

  /** For cli: command configuration */
  cli?: {
    /** Primary binary name */
    bin: string;
    /** Subcommands exposed as tools */
    commands?: CliCommand[];
    /** Environment variables to pass */
    env?: Record<string, string>;
  };

  /** For guide: context configuration */
  guide?: {
    /** When to inject this guide */
    contexts?: Array<'group-chat' | 'direct-message' | 'channel' | 'email' | 'any'>;
    /** Priority (higher = more important) */
    priority?: number;
  };

  /** Entry point file (SKILL.md for documentation) */
  entry?: string;

  /** MCP server provided by this skill (stdio transport) */
  mcp?: {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

// ============================================================================
// Function Definitions (for mini-apps)
// ============================================================================

export interface SkillFunction {
  name: string;
  description: string;
  input: Record<string, SkillFieldType>;
  output: Record<string, SkillFieldType>;
}

export type SkillFieldType =
  | 'string'
  | 'string?'
  | 'number'
  | 'number?'
  | 'boolean'
  | 'boolean?'
  | 'array'
  | 'array?'
  | 'object'
  | 'object?';

// ============================================================================
// CLI Commands (for cli skills)
// ============================================================================

export interface CliCommand {
  /** Command name (e.g., "pr list") */
  name: string;
  /** Description */
  description: string;
  /** Tool name to register */
  toolName?: string;
  /** Arguments template */
  args?: string;
  /** How to handle arguments */
  argMode?: 'raw' | 'json' | 'flags';
}

// ============================================================================
// Loaded Skill (runtime representation)
// ============================================================================

export interface LoadedSkill {
  manifest: SkillManifest;
  /** Full SKILL.md content */
  skillContent: string;
  /** Source path */
  sourcePath: string;
  /** Eligibility check result */
  eligibility: EligibilityResult;
  /** For mini-apps: loaded functions */
  functions?: Record<string, (...args: unknown[]) => unknown>;
}

// ============================================================================
// User Skill Settings
// ============================================================================

export interface UserSkillSettings {
  skillName: string;
  enabled: boolean;
  /** User-specific configuration */
  config?: Record<string, unknown>;
  /** Last time skill was used */
  lastUsedAt?: string;
  /** Usage count */
  usageCount?: number;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface SkillSummary {
  name: string;
  displayName: string;
  description: string;
  type: SkillType;
  emoji?: string;
  category?: string;
  tags?: string[];
  version: string;
  status: SkillStatus;
  triggers?: string[];
  functionCount?: number;
  capabilities?: SkillManifest['capabilities'];
  eligibility: EligibilityResult;
  mcp?: SkillManifest['mcp'];
}

export interface SkillDetail extends SkillSummary {
  skillContent: string;
  manifest: SkillManifest;
  userSettings?: UserSkillSettings;
  usageStats?: {
    totalRecords: number;
    lastUsedAt?: string;
  };
}

export interface SkillsListResponse {
  skills: SkillSummary[];
  categories: string[];
  totalCount: number;
}

// ============================================================================
// Cloud/Database Types
// ============================================================================

/**
 * Skill record from the database (skills table)
 */
export interface DbSkill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: SkillType;
  category: string | null;
  tags: string[];
  emoji: string | null;
  currentVersion: string;
  manifest: SkillManifest;
  content: string;
  author: string | null;
  authorUserId: string | null;
  repositoryUrl: string | null;
  homepageUrl: string | null;
  isOfficial: boolean;
  isPublic: boolean;
  isVerified: boolean;
  installCount: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/**
 * Skill version record from the database (skill_versions table)
 */
export interface DbSkillVersion {
  id: string;
  skillId: string;
  version: string;
  manifest: SkillManifest;
  content: string;
  changelog: string | null;
  publishedBy: string | null;
  publishedAt: string;
}

/**
 * Skill installation record from the database (skill_installations table)
 */
export interface DbSkillInstallation {
  id: string;
  userId: string;
  skillId: string;
  versionPinned: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  installedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
}

/**
 * Joined view of user's installed skills with resolved content
 */
export interface UserInstalledSkill {
  installationId: string;
  userId: string;
  enabled: boolean;
  userConfig: Record<string, unknown>;
  versionPinned: string | null;
  installedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
  skillId: string;
  name: string;
  displayName: string;
  description: string;
  type: SkillType;
  category: string | null;
  tags: string[];
  emoji: string | null;
  currentVersion: string;
  manifest: SkillManifest;
  content: string;
  isOfficial: boolean;
  isVerified: boolean;
  author: string | null;
  repositoryUrl: string | null;
  resolvedContent: string;
  resolvedManifest: SkillManifest;
  resolvedVersion: string;
}

// ============================================================================
// Cloud API Types
// ============================================================================

/**
 * Options for listing skills from the registry
 */
export interface ListRegistrySkillsOptions {
  type?: SkillType;
  category?: string;
  search?: string;
  isOfficial?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Options for installing a skill
 */
export interface InstallSkillOptions {
  skillId: string;
  userId: string;
  versionPinned?: string;
  config?: Record<string, unknown>;
}

/**
 * Options for publishing a skill to the registry
 */
export interface PublishSkillOptions {
  name: string;
  displayName: string;
  description: string;
  type: SkillType;
  category?: string;
  tags?: string[];
  emoji?: string;
  version: string;
  manifest: Partial<SkillManifest>;
  content: string;
  authorUserId?: string;
  repositoryUrl?: string;
  isPublic?: boolean;
}

/**
 * Registry skill summary for browsing
 */
export interface RegistrySkillSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: SkillType;
  category: string | null;
  tags: string[];
  emoji: string | null;
  currentVersion: string;
  author: string | null;
  isOfficial: boolean;
  isVerified: boolean;
  installCount: number;
  /** Whether the current user has this installed */
  isInstalled?: boolean;
}

/**
 * Full registry skill detail
 */
export interface RegistrySkillDetail extends RegistrySkillSummary {
  manifest: SkillManifest;
  content: string;
  repositoryUrl: string | null;
  homepageUrl: string | null;
  versions: Array<{
    version: string;
    publishedAt: string;
    changelog: string | null;
  }>;
}

// ============================================================================
// Skill Management Types
// ============================================================================

/**
 * Registry status for skills (different from display SkillStatus)
 */
export type SkillRegistryStatus = 'active' | 'deprecated' | 'deleted';

/**
 * Options for forking a skill
 */
export interface ForkSkillOptions {
  sourceSkillId: string;
  newName: string;
  newDisplayName?: string;
  forkerUserId: string;
  customizations?: {
    description?: string;
    category?: string;
    tags?: string[];
  };
}

/**
 * Options for deprecating a skill
 */
export interface DeprecateSkillOptions {
  skillId: string;
  userId: string;
  message?: string;
}

/**
 * Options for updating skill content with version bump
 */
export interface UpdateSkillContentOptions {
  displayName?: string;
  description?: string;
  category?: string | null;
  tags?: string[];
  emoji?: string | null;
  version: string; // Required for version bump
  content?: string;
  manifest?: Partial<SkillManifest>;
  changelog?: string;
}

/**
 * Extended DbSkill with management fields
 */
export interface DbSkillWithManagement extends DbSkill {
  forkedFromId: string | null;
  status: SkillRegistryStatus;
  deprecatedAt: string | null;
  deprecatedBy: string | null;
  deprecationMessage: string | null;
  lastPublishedBy: string | null;
}
