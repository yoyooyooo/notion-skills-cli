export type SmokeContext = Awaited<ReturnType<typeof import("./consumer.ts").prepareConsumer>>
