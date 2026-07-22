import { describe, it, expect } from "bun:test"
import { isQuestionNotInstruction } from "../lib/assistant-guard"

describe("投标助手提问拦截（拦截=不发起计费改写）", () => {
  it("明显提问 → 拦截", () => {
    expect(isQuestionNotInstruction("你改了哪里?")).toBe(true)
    expect(isQuestionNotInstruction("改了什么")).toBe(true)
    expect(isQuestionNotInstruction("你是谁")).toBe(true)
    expect(isQuestionNotInstruction("为什么扣我积分？")).toBe(true)
    expect(isQuestionNotInstruction("这个有什么用")).toBe(true)
  })

  it("审查实证：含「把/改成」的提问也要拦（提问判定先于动词判定）", () => {
    expect(isQuestionNotInstruction("你把哪里改了？")).toBe(true)
    expect(isQuestionNotInstruction("为什么把响应时间改成15分钟？")).toBe(true)
  })

  it("真改写指令 → 放行（含问句式指令）", () => {
    expect(isQuestionNotInstruction("把响应时间改为15分钟")).toBe(false)
    expect(isQuestionNotInstruction("本章更正式一些")).toBe(false)
    expect(isQuestionNotInstruction("能不能把响应时间改成15分钟?")).toBe(false)
    expect(isQuestionNotInstruction("扩写本章")).toBe(false)
    expect(isQuestionNotInstruction("补充两个公安行业案例")).toBe(false)
  })

  it("审查实证：长输入一律放行（长句里的疑问字眼多半是写作指令的一部分）", () => {
    expect(isQuestionNotInstruction("详细说明本方案与传统方案有什么区别并写进正文加以论证")).toBe(false)
    expect(isQuestionNotInstruction("第五章应急响应部分是否需要写到分钟级的响应承诺呢?")).toBe(false)
    expect(isQuestionNotInstruction("")).toBe(false)
  })
})
