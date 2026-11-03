import { ConfigProvider, Context, Crypto, Effect, Layer, Redacted } from "effect"
import { fail, type SkillsError } from "./model.ts"
import { configuredToken, sha256, Store } from "./store.ts"

export type NotionCredential = {
  readonly token: Redacted.Redacted<string>
  readonly identity: string
}

/** Credentials belong to this project. No external CLI login or keychain is read. */
export class NotionCredentialProvider extends Context.Service<
  NotionCredentialProvider,
  { readonly resolve: Effect.Effect<NotionCredential, SkillsError> }
>()("ntn-skills/NotionCredentialProvider") {}

export const NotionCredentialProviderLive = Layer.effect(
  NotionCredentialProvider,
  Effect.gen(function* () {
    const store = yield* Store
    const crypto = yield* Crypto.Crypto
    const configProvider = yield* ConfigProvider.ConfigProvider
    return {
      resolve: Effect.gen(function* () {
        const token = yield* configuredToken.pipe(
          Effect.provideService(Store, store),
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
        )
        if (!token)
          return yield* Effect.fail(
            fail(
              "AUTH_REQUIRED",
              "Configure a Notion token with ctl config set-token --stdin or NOTION_API_TOKEN.",
              {
                phase: "input_rejected",
              },
            ),
          )
        if (/\s/u.test(token))
          return yield* Effect.fail(
            fail("CONFIG_ERROR", "The configured Notion token must not contain whitespace.", {
              phase: "input_rejected",
            }),
          )
        return {
          token: Redacted.make(token),
          identity: yield* sha256(token).pipe(Effect.provideService(Crypto.Crypto, crypto)),
        }
      }),
    }
  }),
)
