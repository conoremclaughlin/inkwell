#!/bin/sh
# Vendor credential shapes shared by the staged-file guard
# (scripts/check-staged-files.sh) and the pre-push replay (scripts/check-push.sh).
#
# Sourced, never executed. Sets ONE variable, `shapes`, and nothing else.
#
# This is the same expression as `shapes=` in scripts/check-commit-msg.sh, and
# scripts/check-staged-files.test.sh asserts the two stay byte-identical, so
# a pattern added to one guard cannot silently be missing from the other.
# The message guard keeps its own copy rather than sourcing this file because
# it is already deployed as the commit-msg hook on every checkout and its
# 1200-line suite pins it as-is; folding it in is a follow-up, not a
# prerequisite.
#
# Named-variable assignments (JWT_SECRET= and friends) are deliberately NOT
# here. They are the right rule for a commit MESSAGE, where an assignment line
# only ever arrives by accident, and the wrong rule for FILE CONTENT, where
# .env.example, docker-compose files and this repository's own docs legitimately
# write `JWT_SECRET=` as a placeholder or as prose. For files the boundary is
# the filename list in check-staged-files.sh plus these vendor shapes.
shapes='(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20}|GOCSPX-[A-Za-z0-9_-]{20}|sb_secret_[A-Za-z0-9_-]{20}|sk-ant-[A-Za-z0-9_-]{20}|[0-9]{8,10}:AA[A-Za-z0-9_-]{33})'
