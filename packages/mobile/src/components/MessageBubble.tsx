import { StyleSheet, Text, View } from 'react-native';
import type { ThreadMessage } from '../lib/types';
import { messageTime, senderName } from '../ui/format';
import { agentColor, colors, spacing, type } from '../ui/theme';

/**
 * One message. The user's own replies sit right and accent-tinted, agents
 * sit left with their identity hue on the name — the familiar chat grammar,
 * because that's the point of the app: your threads, readable as chat.
 *
 * Content is rendered as plain text on purpose. Agents write markdown at
 * each other, but a wrong-looking asterisk is a smaller failure than a
 * markdown renderer's worth of dependencies in v1.
 */
export function MessageBubble({ message }: { message: ThreadMessage }) {
  const sender = senderName(message.senderAgentId, message.metadata);
  const system = message.messageType === 'system' || message.messageType === 'notification';

  if (system) {
    return (
      <View style={styles.systemWrap}>
        <Text style={styles.systemText} numberOfLines={6}>
          {message.content}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, sender.isUser ? styles.wrapUser : styles.wrapAgent]}>
      <View style={styles.header}>
        <Text
          style={[
            styles.sender,
            { color: sender.isUser ? colors.accentBright : agentColor(message.senderAgentId) },
          ]}
        >
          {sender.name}
        </Text>
        <Text style={styles.time}>{messageTime(message.createdAt)}</Text>
        {message.priority !== 'normal' ? (
          <Text
            style={[styles.priority, message.priority === 'urgent' && { color: colors.negative }]}
          >
            {message.priority}
          </Text>
        ) : null}
      </View>
      <View style={[styles.bubble, sender.isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        <Text style={styles.content} selectable>
          {message.content}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, marginVertical: spacing.xs, maxWidth: '100%' },
  wrapUser: { alignItems: 'flex-end' },
  wrapAgent: { alignItems: 'flex-start' },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginBottom: 3 },
  sender: { ...type.label },
  time: { ...type.caption, color: colors.textMuted },
  priority: { ...type.label, color: colors.warning },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    maxWidth: '94%',
  },
  bubbleAgent: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderTopLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: colors.accentDim,
    borderTopRightRadius: 4,
  },
  content: { ...type.body, color: colors.textPrimary, lineHeight: 21 },
  systemWrap: {
    paddingHorizontal: spacing.xl,
    marginVertical: spacing.sm,
    alignItems: 'center',
  },
  systemText: { ...type.caption, color: colors.textMuted, textAlign: 'center' },
});
