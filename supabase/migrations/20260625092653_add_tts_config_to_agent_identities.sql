-- Per-agent TTS voice configuration.
-- Stores model → voice mappings so each SB gets an appropriate default voice.
-- Example: {"defaultVoice": "vivian", "voices": {"mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit": "vivian", "openai/tts-1": "nova"}}
ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS tts_config jsonb;
