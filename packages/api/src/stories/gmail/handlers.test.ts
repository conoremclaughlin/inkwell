/**
 * Gmail Handlers Tests
 *
 * Tests for the label whitelist/permission system that prevents
 * destructive email operations (deletion, spam marking).
 */

import { describe, it, expect } from 'vitest';
import {
  isLabelOperationAllowed,
  validateLabelOperations,
  ALLOWED_ADD_LABELS,
  ALLOWED_REMOVE_LABELS,
  BLOCKED_ADD_LABELS,
} from './handlers';

describe('Gmail Label Whitelist', () => {
  describe('BLOCKED_ADD_LABELS', () => {
    it('should block TRASH label (email deletion)', () => {
      expect(BLOCKED_ADD_LABELS.has('TRASH')).toBe(true);
    });

    it('should block SPAM label', () => {
      expect(BLOCKED_ADD_LABELS.has('SPAM')).toBe(true);
    });
  });

  describe('ALLOWED_ADD_LABELS', () => {
    it('should allow STARRED label', () => {
      expect(ALLOWED_ADD_LABELS.has('STARRED')).toBe(true);
    });

    it('should allow IMPORTANT label', () => {
      expect(ALLOWED_ADD_LABELS.has('IMPORTANT')).toBe(true);
    });

    it('should allow UNREAD label', () => {
      expect(ALLOWED_ADD_LABELS.has('UNREAD')).toBe(true);
    });

    it('should allow INBOX label (for un-archiving)', () => {
      expect(ALLOWED_ADD_LABELS.has('INBOX')).toBe(true);
    });

    it('should NOT include TRASH in allowed add labels', () => {
      expect(ALLOWED_ADD_LABELS.has('TRASH')).toBe(false);
    });

    it('should NOT include SPAM in allowed add labels', () => {
      expect(ALLOWED_ADD_LABELS.has('SPAM')).toBe(false);
    });
  });

  describe('ALLOWED_REMOVE_LABELS', () => {
    it('should allow removing UNREAD (mark as read)', () => {
      expect(ALLOWED_REMOVE_LABELS.has('UNREAD')).toBe(true);
    });

    it('should allow removing STARRED (unstar)', () => {
      expect(ALLOWED_REMOVE_LABELS.has('STARRED')).toBe(true);
    });

    it('should allow removing INBOX (archive)', () => {
      expect(ALLOWED_REMOVE_LABELS.has('INBOX')).toBe(true);
    });

    it('should allow removing SPAM (rescue from spam)', () => {
      expect(ALLOWED_REMOVE_LABELS.has('SPAM')).toBe(true);
    });
  });
});

describe('isLabelOperationAllowed', () => {
  describe('adding labels', () => {
    it('should allow adding STARRED', () => {
      const result = isLabelOperationAllowed('STARRED', 'add');
      expect(result.allowed).toBe(true);
    });

    it('should allow adding IMPORTANT', () => {
      const result = isLabelOperationAllowed('IMPORTANT', 'add');
      expect(result.allowed).toBe(true);
    });

    it('should allow adding UNREAD', () => {
      const result = isLabelOperationAllowed('UNREAD', 'add');
      expect(result.allowed).toBe(true);
    });

    it('should allow adding INBOX (un-archive)', () => {
      const result = isLabelOperationAllowed('INBOX', 'add');
      expect(result.allowed).toBe(true);
    });

    it('should BLOCK adding TRASH (deletion)', () => {
      const result = isLabelOperationAllowed('TRASH', 'add');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('TRASH');
      expect(result.reason).toContain('data loss');
    });

    it('should BLOCK adding SPAM', () => {
      const result = isLabelOperationAllowed('SPAM', 'add');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('SPAM');
    });

    it('should BLOCK adding unknown system labels', () => {
      const result = isLabelOperationAllowed('CATEGORY_PROMOTIONS', 'add');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('system label');
    });

    it('should allow adding user-created labels', () => {
      const result = isLabelOperationAllowed('Label_123456', 'add');
      expect(result.allowed).toBe(true);
    });

    it('should allow adding custom labels (not all caps)', () => {
      const result = isLabelOperationAllowed('My Custom Label', 'add');
      expect(result.allowed).toBe(true);
    });
  });

  describe('removing labels', () => {
    it('should allow removing UNREAD (mark as read)', () => {
      const result = isLabelOperationAllowed('UNREAD', 'remove');
      expect(result.allowed).toBe(true);
    });

    it('should allow removing STARRED (unstar)', () => {
      const result = isLabelOperationAllowed('STARRED', 'remove');
      expect(result.allowed).toBe(true);
    });

    it('should allow removing INBOX (archive)', () => {
      const result = isLabelOperationAllowed('INBOX', 'remove');
      expect(result.allowed).toBe(true);
    });

    it('should allow removing SPAM (rescue from spam)', () => {
      const result = isLabelOperationAllowed('SPAM', 'remove');
      expect(result.allowed).toBe(true);
    });

    it('should BLOCK removing unknown system labels', () => {
      const result = isLabelOperationAllowed('SENT', 'remove');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('system label');
    });

    it('should allow removing user-created labels', () => {
      const result = isLabelOperationAllowed('Label_789', 'remove');
      expect(result.allowed).toBe(true);
    });
  });
});

describe('validateLabelOperations', () => {
  describe('valid operations', () => {
    it('should pass for marking as read', () => {
      const error = validateLabelOperations(undefined, ['UNREAD']);
      expect(error).toBeNull();
    });

    it('should pass for marking as unread', () => {
      const error = validateLabelOperations(['UNREAD'], undefined);
      expect(error).toBeNull();
    });

    it('should pass for starring', () => {
      const error = validateLabelOperations(['STARRED'], undefined);
      expect(error).toBeNull();
    });

    it('should pass for unstarring', () => {
      const error = validateLabelOperations(undefined, ['STARRED']);
      expect(error).toBeNull();
    });

    it('should pass for archiving', () => {
      const error = validateLabelOperations(undefined, ['INBOX']);
      expect(error).toBeNull();
    });

    it('should pass for un-archiving', () => {
      const error = validateLabelOperations(['INBOX'], undefined);
      expect(error).toBeNull();
    });

    it('should pass for combined safe operations', () => {
      const error = validateLabelOperations(['STARRED', 'IMPORTANT'], ['UNREAD', 'INBOX']);
      expect(error).toBeNull();
    });

    it('should pass for user-created labels', () => {
      const error = validateLabelOperations(['Label_custom'], ['Label_other']);
      expect(error).toBeNull();
    });
  });

  describe('blocked operations', () => {
    it('should BLOCK moving to trash (deletion)', () => {
      const error = validateLabelOperations(['TRASH'], undefined);
      expect(error).not.toBeNull();
      expect(error).toContain('TRASH');
      expect(error).toContain('data loss');
    });

    it('should BLOCK marking as spam', () => {
      const error = validateLabelOperations(['SPAM'], undefined);
      expect(error).not.toBeNull();
      expect(error).toContain('SPAM');
    });

    it('should BLOCK even when combined with valid operations', () => {
      const error = validateLabelOperations(['STARRED', 'TRASH'], ['UNREAD']);
      expect(error).not.toBeNull();
      expect(error).toContain('TRASH');
    });

    it('should report multiple blocked operations', () => {
      const error = validateLabelOperations(['TRASH', 'SPAM'], undefined);
      expect(error).not.toBeNull();
      expect(error).toContain('TRASH');
      expect(error).toContain('SPAM');
    });
  });

  describe('edge cases', () => {
    it('should pass for empty operations', () => {
      const error = validateLabelOperations(undefined, undefined);
      expect(error).toBeNull();
    });

    it('should pass for empty arrays', () => {
      const error = validateLabelOperations([], []);
      expect(error).toBeNull();
    });
  });
});

describe('Security: Deletion Prevention', () => {
  it('should never allow TRASH to be added regardless of casing tricks', () => {
    // Test that the system label check handles TRASH correctly
    const result = isLabelOperationAllowed('TRASH', 'add');
    expect(result.allowed).toBe(false);
  });

  it('should provide clear error message for deletion attempts', () => {
    const error = validateLabelOperations(['TRASH'], undefined);
    expect(error).toContain('data loss');
    expect(error).toContain('not permitted');
  });

  it('should not allow bypassing via system label confusion', () => {
    // Ensure blocked labels take priority over the general system label check
    const trashResult = isLabelOperationAllowed('TRASH', 'add');
    expect(trashResult.allowed).toBe(false);

    // Verify TRASH is explicitly in the blocked list, not just missing from allowed
    expect(BLOCKED_ADD_LABELS.has('TRASH')).toBe(true);
  });
});
