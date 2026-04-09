# X 混合中英内容跳过翻译方案

## 任务目标
解决 `x.com` 上「中文为主、夹杂少量英文」的内容仍被送去翻译的问题。目标是减少不必要翻译，同时不误伤真正需要翻译的英文或英文主导内容。

## 用户要求
- 先调研社区/业界如何处理这类 mixed-language / code-switching 文本。
- 基于调研结果，给出推荐实现方案。
- 本次实施范围优先限定在 `x.com`，不要顺手改成全站策略。
- 计划获批后的执行产物需额外保存到仓库本地 `docs/designs/` 目录下（建议文件名：`docs/designs/x-mixed-language-skip-plan.md`）。

## 当前代码现状
### 关键实现位置
- `src/content/extractor.ts`
  - `isChineseDominant(text)`：当前仅按 CJK 字符占比 `> 0.5` 判断“中文主导”。
  - `shouldSkipElement(el, compat)`：在通用跳过逻辑里直接用 `isChineseDominant(el.textContent ?? '')` 跳过整段文本。
  - `collectParagraphs()` / `extractQuickTranslateParagraph()`：X 的推文正文最终都会走这里的过滤逻辑。
- `src/content/compat.ts`
  - `twitterCompat.paragraphSelector` 当前会抓：
    - `div[data-testid="tweetText"]`
    - `div[data-testid="UserDescription"]`
    - `div[data-testid="birdwatch-pivot"] span`
    - `article div[lang]`
- `src/shared/prompt.ts`
  - 目前只是提示模型：如果段落已经是目标语言则原样返回。
  - 这对“中文主导但夹杂英文”的文本不够稳，因为模型仍可能重写英文片段或整段重译。

### 当前问题判断
现有逻辑过于粗糙：
- 只看“CJK 字符 / 全部非空白字符”占比，容易被英文单词、URL、mention、hashtag、标点、emoji 稀释。
- 这是通用规则，但问题主要出现在 `x.com` 的短文本、强噪声、强 code-switch 场景。
- 目前没有“低置信度返回 unknown / 保守跳过”的机制。

## 调研结论
### 社区常见做法
1. 不要只依赖翻译服务端的 auto-detect
   - 社区 bug 里反复出现 mixed-language 文本被错误识别成英文，导致整段“不该翻/该翻没翻”。
   - 典型做法是在客户端先做一层脚本/语言预判，再决定是否送翻译。
2. 混合语言文本优先做“dominant language + confidence/threshold”判断
   - 不是二元地问“是不是中文”，而是判断：
     - 主导语言是谁
     - 置信度是否足够
     - 是否只是少量 foreign tokens 嵌入
   - 低置信度时宁可保守，不强行判定。
3. 短文本要单独处理
   - 社区经验和官方文档都指出：短句、单词、社交媒体文本的语言识别最不稳定。
   - 常见策略：
     - 设最小文本长度/最小词数阈值
     - 对短文本提高阈值
     - 置信度不够时返回 unknown
4. 混合语言/批量内容尽量按更小粒度判断
   - 对整页/整批统一判语言很容易被少量英文 UI、用户名、时间戳污染。
   - 更稳的方式是按 paragraph / sentence / chunk 判断。
   - 本项目当前就是 paragraph 级提取，因此适合在 paragraph 级做更精细的 skip 判断。
5. 实践上常用脚本比例 + 词法启发式，而不是一上来引入重型 detector
   - 浏览器扩展里更常见的是：
     - CJK/Latin script 比例
     - URL / mention / hashtag / acronym 过滤
     - 词数阈值
   - 原因：简单、快、可测、可控，不依赖额外模型下载。

### 与本项目最相关的外部参考
1. Chrome Language Detector 文档
   - 官方明确建议：短文本应结合 confidence threshold，低置信度时返回 unknown。
   - 还强调 API 返回 ranked candidates，而不是只给单一标签。
   - 结论：有参考价值，但不建议本轮直接采用，因为它是实验性 API，且需要模型可用性/下载流程。
2. `LibreTranslate` mixed-language issue #119
   - 社区反馈：整批 mixed-language 文本做 auto-detect 会误判。
   - 讨论中明确建议：若可能存在多语言，按 sentence/chunk 检测更稳。
   - 这与我们在 X 上的 paragraph 级判断方向一致。
3. `Traduzir paginas web` issue #962
   - 社区 workaround：在调用翻译前先用中文字符占比覆盖错误 auto-detect。
   - 说明“客户端脚本比例预判”是实际被采用的工程做法。
4. `read-frog` PR #862
   - 社区在网页翻译里新增 `minWordsPerNode`，用 `Intl.Segmenter` 做跨语言词数过滤。
   - 这说明“短文本阈值 + 语言无关分词”是实际产品里会落地的方案。

## 方案取舍
### 备选方案 A：只改 prompt
优点：改动小。
缺点：不确定、不可验证、依赖模型听话；同一段文本在不同模型/provider 下行为会漂。

结论：不选。

### 备选方案 B：引入浏览器 `LanguageDetector`
优点：有 confidence、ranked candidates，看上去更“正统”。
缺点：实验性、浏览器能力和模型下载受限、接入复杂、测试成本高、对每段文本调用的开销和状态管理更重。

结论：本轮不选。

### 推荐方案 C：X 站点专用的“中文主导混合文本跳过”启发式
核心思想：
- 保留现有通用过滤框架。
- 对 `x.com` 追加一个站点专用文本分类器，只在正文提取阶段生效。
- 用“脚本占比 + 词法噪声过滤 + 最小词数/最小英文 token 数 + 保守阈值”判断是否应跳过翻译。

结论：选 C。

## 推荐实现
### 设计原则
- 先在 X 单站点修正，不扩散到全站。
- 在发请求前跳过，不把问题甩给 LLM prompt。
- 保守判定：只有足够确定是“中文主导、英文只是嵌入噪声/术语”时才跳过。
- 英文主导或真正双语内容仍允许翻译。

### 拟新增/调整的判断逻辑
在 `src/content/extractor.ts` 新增一个面向文本的分类 helper（名称可定为 `shouldSkipXMixedChineseText` 或 `classifyMixedLanguageText`），供 X compat 路径调用。

建议规则：
1. 先做文本归一化
   - 去掉多余空白
   - 剔除/弱化这些噪声对语言判断的影响：
     - URL
     - `@mention`
     - `#hashtag`
     - 纯数字/时间戳
     - emoji
   - 保留真实英文词和中文内容
2. 统计信号
   - CJK 字符数
   - Latin 字母字符数
   - Latin word token 数（优先用正则；若需要更稳，可引入 `Intl.Segmenter`，但不是硬要求）
   - 文本总有效字符数
3. X 专用跳过条件（推荐初版）
   - 文本有效长度达到最小阈值，且
   - CJK 明显主导，例如：
     - `cjkRatio >= 0.45 ~ 0.55` 区间内择一保守值
   - 同时英文只是有限嵌入，例如满足以下任一：
     - Latin token 数很少（如 `<= 3` 或 `<= 4`）
     - Latin 字符占比低于较低阈值
     - Latin token 主要是 acronym / brand / product terms / 单个短词
   - 若英文 token 较多、出现完整英文从句、或 Latin 占比接近/超过中文，则不要跳过
4. 接入点
   - 不要替换全局 `isChineseDominant()` 语义。
   - 优先在 `shouldSkipElement()` 里根据 `getMainDomain(location.hostname) === 'x.com'` 或 `compat` 增加站点专用判断。
   - 更干净的做法是给 `SiteCompat` 增加新的文本级 hook，例如：
     - `shouldSkipText?: (text: string, context: SiteSkipContext) => boolean`
   - 然后在 `shouldSkipElement()` / `tryCollectElement()` 里在拿到 trimmed text 后调用。

### 推荐结构调整
优先采用下面这套，接口更诚实：
- `src/content/compat.ts`
  - 给 `SiteCompat` 新增文本级判断 hook（例如 `shouldSkipText`）
  - 在 `twitterCompat` 中实现 X 专用 mixed-language skip 规则
- `src/content/extractor.ts`
  - 保留 `isChineseDominant()` 给通用场景使用
  - 新增更细的文本分析 helper（脚本统计、token 统计、噪声剔除）
  - 在 `shouldSkipElement()` / `tryCollectElement()` 调用 compat 的文本级 hook

这样做的原因：
- 问题是 X 站点特有语料特征，不应该污染全局中文判定。
- `SiteCompat.shouldSkip(el)` 只拿到 DOM，不适合表达“基于归一化文本分析后再跳过”的规则。
- 文本级 hook 更容易单测，也更容易之后给 GitHub/HN 等站点扩展独立策略。

## 需要修改的关键文件
- `src/content/compat.ts`
- `src/content/extractor.ts`
- `tests/unit/compat.test.ts`
- `tests/unit/extractor.test.ts`

## 实施步骤
1. 在 `compat.ts` 为 `SiteCompat` 增加文本级 skip hook。
2. 在 `extractor.ts` 提取文本分析 helper：
   - 文本归一化
   - URL/mention/hashtag/emoji/数字噪声剔除
   - CJK/Latin 统计
   - Latin token 统计
3. 在 `twitterCompat` 中实现 X 专用 mixed-language skip 规则。
4. 在 paragraph 收集和 quick translate 路径都接入该规则，保证页面翻译和悬停翻译行为一致。
5. 补测试，覆盖：
   - 纯中文 → 跳过翻译
   - 中文主导 + 少量英文术语 → 跳过翻译
   - 中文主导 + URL/mention/hashtag → 跳过翻译
   - 英文主导 + 少量中文 → 不跳过
   - 真正完整英文句子 → 不跳过
   - 中英各半/低置信度 → 保守地不跳过
   - X 站点生效，非 X 站点不受影响

## 验证方案
### 单元测试
运行最小必要测试：
- `tests/unit/extractor.test.ts`
- `tests/unit/compat.test.ts`

重点验证：
- 新 helper 的边界条件
- `collectParagraphs()` 在 `x.com` 下是否跳过中文主导 mixed 文本
- `extractQuickTranslateParagraph()` 在 `x.com` 下是否与页面翻译一致

### 手动验证
在 X 页面准备 5 类样本：
1. 纯中文推文
2. 中文主导 + 1~3 个英文术语
3. 中文主导 + mention / hashtag / URL
4. 英文主导 + 少量中文词
5. 完整英文推文

预期：
- 1/2/3 不再触发翻译
- 4/5 仍可翻译

## 风险与防线
### 主要风险
- 阈值过激：误伤真正需要翻译的 bilingual 内容。
- 阈值过松：问题改善不明显。

### 防线
- 范围只限 `x.com`
- 低置信度默认“不跳过”，避免错杀
- 通过单测把阈值语义写死，后续调参可控

## 暂不做
- 不改全站通用中文检测逻辑
- 不引入浏览器 `LanguageDetector`
- 不只靠 prompt 修补
- 不做服务端/模型级 auto-detect 重构

## 参考资料
- Chrome Language Detector: https://developer.chrome.com/docs/ai/language-detection
- MDN LanguageDetector: https://developer.mozilla.org/en-US/docs/Web/API/LanguageDetector
- LibreTranslate mixed-language issue #119: https://github.com/LibreTranslate/LibreTranslate/issues/119
- Traduzir paginas web issue #962: https://github.com/FilipePS/Traduzir-paginas-web/issues/962
- read-frog PR #862 (`minWordsPerNode` / `Intl.Segmenter`): https://github.com/mengxi-ream/read-frog/pull/862
- 背景文章（code-switching / confidence thresholds / multilingual detection）: https://mbrenndoerfer.com/writing/language-identification-models-multilingual-code-switching
