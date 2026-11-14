# MaintenanceApply: independently reviewed partial completion

The existing bounded model now distinguishes a known failed child that has been
explicitly reviewed from an unproven unknown. That review can close the original
parent as **partial** without sending its remaining children. It does not turn
the original failed write into applied, claim full completion, or permit replay
of an unknown request.

[Positive workflow](MaintenanceApply-cfg.svg) · [Mermaid](MaintenanceApply-cfg.mmd) · [Original report](MaintenanceApply-cfg.report.md)

The positive configuration explores 109 distinct states. A partial parent needs
the original review, while a complete parent still needs every verified child.

[Missing-review counterexample](MaintenanceApply-unreviewed-partial-cfg.svg) · [Mermaid](MaintenanceApply-unreviewed-partial-cfg.mmd) · [Original report](MaintenanceApply-unreviewed-partial-cfg.report.md)

The negative configuration explores 118 distinct states and breaks only
`PartialRequiresOriginalReview`. The normalizer, production response-loss
handling and complete body evidence remain separate implementation checks.

All seven MaintenanceApply configurations ran to completion and matched their
expected outcomes. The [manifest](manifest.json) records each selected input,
the runner/tool lock and generated artifact hashes. The old diagrams remain
historical rather than being relabeled as this result. Self-loops and repeated
internal labels follow the existing statechart renderer's display rules; no
additional model phase was hidden for this change.

Use the tool configuration in the [operation-recovery guide](../../../verification/models/operation-recovery/README.md) and the existing [rendering procedure](../../formal-verification-maintenance.md#图形产物定位与复现):

```sh
node scripts/verify-resource-lifecycle.mjs --suite operation-recovery \
  --model MaintenanceApply --out /absolute/new/maintenance-results
```

The source uses three ordered child slots. The model does not prove arbitrary
Notion transactions, server compare-and-swap, eventual recovery, literal byte
preservation, or cross-machine authorization. Those limits are unchanged. The
EMPTY real-library recipe and concrete regressions independently verify the
observed page identities, content and table relationships.
