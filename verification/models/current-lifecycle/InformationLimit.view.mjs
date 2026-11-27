export const title = "仅有本地缓存时无法知道未观察到的远端修改"
export const state = (v) =>
  v.consumed !== -1
    ? v.consumed === v.remoteAtRead
      ? "消费时版本相同"
      : "消费内容落后于远端"
    : v.remoteVersion === 1
      ? "远端已变，本地尚未知"
      : "已有有效缓存"
export const step = (action) =>
  ({
    HiddenRemoteEdit: "远端修改但尚无可见信号",
    ConsumeWithinTTL: "在有效期内读取缓存",
    Idle: null,
  })[action] ?? action
