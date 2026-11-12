# ProjectionRace

TLC reached 11 states and 14 steps. The chart draws 10 states and 10 arrows.
The chart does not draw 4 steps that stay in one chart state.

## HumanEditPreserved breaks
The shortest path has 4 steps:
0. 页面仍展示上游 v1
1. 检查当前正文: 已读回原文一致
2. 检查写入能力: 准备执行覆盖
3. 你编辑 Notion 页面: 写入前发生人工编辑
4. 服务端执行覆盖: 人工内容已被覆盖

## Rules that hold
TypeOK, NoDeadlock
