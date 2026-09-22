# Follow-up Fast Path V2 — Implementation Audit

This checklist audits the ordinary-chat latency work against the implementation plan agreed before coding.

## Product scope

This applies to ordinary Tutor chat and ordinary follow-up turns. Deep Solve, research/tool-heavy turns, Math Animator, persistence ownership, authentication, and Virtual Internship are outside this latency path.

## Implementation checklist

- [x] **Per-turn latency instrumentation**
  - Records raw history characters, compact packet characters, context build time, cache hit, winning provider, first-token latency, continuation count, and total turn latency.
  - Evidence: `tutor/railway/accelerate_chat.py` (`MURIKAH_LATENCY` events).

- [x] **Compact Conversation Context Packet**
  - Default ordinary follow-up context reduced from the previous 60,000-character replay budget to a 16,000-character packet.
  - Preserves system instructions, compact older-summary memory, latest verbatim turns, and the exact newest learner prompt.
  - Evidence: `tutor/railway/murikah_context_packet.py`.

- [x] **Pre-build the next follow-up context**
  - On completion, the next context packet is prepared asynchronously outside the learner-facing generation critical path.
  - A strong task reference is retained until background preparation completes.
  - The next turn consumes the cached packet when available and safely rebuilds after a process restart/cache miss.
  - Evidence: `schedule_next_context()`, `context_packet_for_turn()`.

- [x] **Explicit fast/deep per-turn routing**
  - Ordinary Chat starts in the fast lane.
  - Persistent metadata from earlier turns is not sufficient to promote a follow-up.
  - Deep promotion requires current-turn flags, attachment use, or knowledge-base use.
  - Evidence: `_agent_reason()` in `tutor/railway/accelerate_chat.py`.

- [x] **8–10 second first-token discipline**
  - Per-provider first-token timeout: 8 seconds.
  - Overall fast-race target: 10–12 seconds, with rapid hedges.
  - Retry race remains bounded.
  - Evidence: fast-lane constants and `race_first_visible()`.

- [x] **12–15 second stream-idle ceiling**
  - Ordinary chat idle timeout reduced from 45 seconds to 15 seconds.
  - Evidence: `MURIKAH_CHAT_STREAM_IDLE_TIMEOUT_SECONDS`.

- [x] **Normal-turn ceiling reduced**
  - Ordinary fast segment ceiling reduced from 300 seconds to 45 seconds.
  - Evidence: `MURIKAH_CHAT_FAST_TURN_TIMEOUT_SECONDS`.

- [x] **Only one automatic continuation**
  - Maximum continuation count reduced from up to three to one.
  - Evidence: `MURIKAH_CHAT_MAX_CONTINUATIONS`.

- [x] **Continuation streams live**
  - The continuation winner's first text is de-duplicated and published immediately.
  - Remaining continuation chunks are streamed directly rather than buffered invisibly.
  - Evidence: continuation path calls `collect_remaining(..., publish=True)`.

- [x] **Preserve useful partial answers**
  - If the one recovery continuation still cannot complete, Tutor keeps the already-streamed answer and surfaces a retryable interruption status instead of waiting through more hidden repair cycles.
  - Evidence: `partial_response_preserved` event.

- [x] **Smaller default output budget**
  - Ordinary Chat: 1,800-token default ceiling.
  - Explicit detailed/comprehensive/long-answer request: up to 2,800 tokens.
  - Deep Solve remains separate.
  - Evidence: `turn_output_tokens` selection.

- [x] **Conversation-provider affinity**
  - The previous winning provider becomes the preferred zero-delay candidate for the next turn.
  - Other fast providers hedge rapidly behind it.
  - Evidence: `provider_affinity()` and hedge delays.

- [x] **Follow-up growth tests at turns 1, 2, 5, 10, and 25**
  - Synthetic long histories verify that packet size stays bounded rather than growing linearly with transcript length.
  - Evidence: `tutor/tests/test_context_packet.py`.

- [x] **Provider-private state stripping**
  - Context packets retain only `role` and `content`.
  - Evidence: `test_provider_private_fields_are_not_retained`.

- [x] **Deployment regression protection**
  - Cloudflare preflight requires Fast Path V2 markers and the context packet module.
  - Production container bundles the helper.
  - Image revision bumped to `2026-09-22-v33`.

## Acceptance criteria

A release is acceptable when:

- Tutor-specific preflight passes.
- Cloudflare Worker dry-run/build passes.
- Tutor runtime tests pass.
- Context-packet tests pass.
- Ordinary follow-ups do not silently enter the multi-agent lane due to stale metadata.
- The 25-turn synthetic history remains bounded near the configured 16k packet ceiling.
- A stalled ordinary response cannot consume three 45-second hidden continuation waits.

## Post-deploy observation

After deployment, inspect `MURIKAH_LATENCY` logs for real conversations and compare:

- turn number / follow-up flag;
- `raw_history_chars`;
- `packet_chars`;
- `context_cache_hit`;
- `first_token_ms`;
- provider;
- continuation count;
- `total_ms`.

The expected result is that raw transcript size may continue growing while provider-bound packet size remains bounded, and ordinary follow-up first-token latency remains in the same general range as early turns.
