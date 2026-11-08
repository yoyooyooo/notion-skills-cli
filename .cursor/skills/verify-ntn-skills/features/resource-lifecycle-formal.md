# Resource lifecycle planning checks

Use [`verify-notion-resource-lifecycle`](../../verify-notion-resource-lifecycle/SKILL.md) before changing source update scheduling, file ownership, Notion reading projections, fixed snapshot publication, or the proposed `ctl library audit` command.

This is the formal-checking subtrack of the existing verification map. Product CLI and source adapters remain in the core repository; Broker session delivery remains in its existing integration Skill. Dagu scheduling and notifications are deployment adapters, not another source of content truth.

The executable models and source correspondence live in `verification/models/resource-lifecycle/`. They distinguish current guards, rejected proposals, and desired coordinator behavior. The design/acceptance sequence is `docs/resource-lifecycle-plan.md`. Raw model output, real-service transcripts and failing fixtures stay outside Git. Read the actual expected-rule results rather than treating a tool exit alone as verification.

Implementation completion still requires controlled and actual-consumer checks: no Notion mutation during audit; missing-versus-inaccessible identity; full paginated reverse coverage; bounded resume without skipping objects; per-source acquisition reuse; candidate/view consistency; original unknown-operation recovery; fixed old-session resources; actual minimal model context and request/cache measurements. The finite planning models do not substitute for them.
