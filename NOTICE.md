# 第三方来源声明

本文件登记本项目在设计或实现中参考、采用过的第三方开源材料及其许可证要求。
新增条目时请写明：来源、许可证、我们用到了什么、用在哪里。

---

## bid-toolkit

- **来源**：https://github.com/charlotty2026/bid-toolkit
- **许可证**：MIT License，Copyright (c) 2026 charlotty2026
- **用到了什么**：投标行业知识条目——三类标书（货物 / 服务 / 工程）的必备章节骨架与
  差异化必查项、按关键词触发的行业资质要求清单、服务标「定人定薪」变相最低限价的识别口径、
  服务标「违约责任承诺」为评标必备项这一事实，以及废标判词清单的构成思路。
- **用在哪里**：`docs/superpowers/plans/phase-3/spec334-bid-category.md` 的分类知识初稿，
  以及由该 spec 派生的实现（落地时为 `services/agent/src/agent/agents/bidding_agent/prompts/categories.py`）。
- **我们没有采用的部分**：其类型判定的计分实现（按词频累加、含泛词、兜底默认服务类）——
  实测该口径会把一份服务类招标文件判成货物类，我们改用「同词只计一次 + 只取强信号 +
  领先次高 ≥2，否则不判定」。其面向采购人（甲方）的招标文件生成与合规检查模块整体未采用。
- **状态**：上述知识条目在本项目中均标记为「待验证」，须经我们自己的真实标书语料核对后才转正，
  不直接以「必备」口吻进入生成提示词。

### MIT License 全文（随上述使用一并保留）

```
MIT License

Copyright (c) 2026 charlotty2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE, OR IN CONNECTION WITH THE SOFTWARE.
```
