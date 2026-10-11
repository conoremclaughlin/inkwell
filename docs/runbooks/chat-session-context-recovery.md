# `ink chat` activity-context recovery

Attaching to an existing session prefers its local Ink transcript. Only when
that transcript is absent does the CLI request `get_session_context`, with the
API's maximum of 50 activities.

This is a **bounded operational tail, not a complete conversation transcript**.
A successful empty response means only that this lookup returned no entries.
Transport failures, MCP failures and malformed responses mean context is
unavailable; they do not establish an empty history.

Recovery is stored as one `context_note` before the first provider turn. Activity
records retain their type, sender and timestamp provenance as quoted JSON in an
explicit untrusted-data boundary. They are not minted as authoritative user or
assistant turns. The same note, including an unavailable/empty warning, is read
from the transcript on the next CLI process and on provider reseed. Existing
transcripts are not automatically re-imported or repaired from activity.

The note participates in normal context management. A compaction's kept tail
preserves it verbatim; compaction may instead summarize it, and explicit eviction
or trimming may remove it. It is not an immutable or exhaustive recovery archive.
The CLI labels replayed recovery status as **original recovery**, not as a fresh
lookup or a guarantee that all imported content remains in the active window.
