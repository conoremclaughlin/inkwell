#!/bin/sh
# Email domains an address in a tracked file may use. Sourced by
# scripts/check-staged-files.sh; sets `fixture_domains_legacy` and
# `fixture_domains_infra`, nothing else. Never executed.
#
# The guard applies these rules, in order, to every address it finds:
#
#   1. A reserved name is always allowed: a domain with `example` as one of
#      its labels (example.com, example.net, example.org, their subdomains,
#      example.<anything>) or whose last label is test, invalid, example or
#      localhost. RFC 2606 and RFC 6761 set these aside so that nothing real
#      can ever live there, which is exactly the property a fixture needs.
#   2. Otherwise the domain must appear below, exactly or as a parent: an
#      entry `github.com` also allows `noreply.github.com`.
#   3. Anything else is refused. The report gives the path and line numbers
#      and never prints the address, because the address is the thing that
#      must not be written down again.
#
# Why an allow list and not a block list of mail providers: a real clinic,
# employer or school has a domain that looks exactly like an invented one,
# and no pattern tells them apart. What does tell them apart is that a real
# domain is not on this list, so committing it needs a visible edit here —
# in the diff, in review, with a name attached. That is the point.
#
# LEGACY. Real, registrable domains that were already standing in for
# fixtures when this guard arrived (test.com alone had 256 uses). They are
# grandfathered so the guard could ship without rewriting forty files. The
# list is FROZEN: do not add to it. New fixtures use rule 1, and moving the
# old ones onto reserved names is tracked as an Inkwell task, not licensed
# by this line.
fixture_domains_legacy='test.com x.com y.com z.com b.co b.com c.com d.com z.io evil.com test.local test.dev'

# INFRASTRUCTURE. Hosts that appear in fixtures for what they are and name no
# person: GitHub's notification and noreply senders, the co-author line every
# SB commit ends with, this project's own placeholder, WhatsApp JID suffixes,
# Google Calendar ids, and the Message-ID host of a Gmail fixture. Note that
# `mail.gmail.com` allows a Message-ID and nothing else — `gmail.com` itself
# is not here, so a person's mailbox is still refused.
fixture_domains_infra='github.com anthropic.com pcp.dev s.whatsapp.net g.us group.calendar.google.com mail.gmail.com'
