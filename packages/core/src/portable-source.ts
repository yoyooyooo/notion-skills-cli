import { Context, Effect, Option } from "effect"
import type { ImportFile } from "./import.ts"
import { readPortable, type PortableSkill } from "./portable.ts"

/** Host-selected interpretation of preserved source. Normal hosts always use the strict decoder. */
export class PortableSourceDecoder extends Context.Service<
  PortableSourceDecoder,
  {
    readonly decode: (input: readonly ImportFile[]) => PortableSkill | undefined
    readonly rewriteSourceArchive: boolean
  }
>()("ntn-skills/PortableSourceDecoder") {}

export const portableSourceDecoder = Effect.serviceOption(PortableSourceDecoder).pipe(
  Effect.map((selected) => (Option.isSome(selected) ? selected.value.decode : readPortable)),
)
