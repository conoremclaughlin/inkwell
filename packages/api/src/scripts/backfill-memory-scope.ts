/** Report filter presence without putting private environment values in logs. */
export function describeBackfillScope(filters: {
  sbSlug?: string;
  memoryId?: string;
  topic?: string;
}): string {
  return `user=scoped agentFiltered=${Boolean(filters.sbSlug)} memoryFiltered=${Boolean(filters.memoryId)} topicFiltered=${Boolean(filters.topic)}`;
}
