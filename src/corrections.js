// 题库文本修复（纯函数，无 Node 依赖）
// bank-corrections.js 只收录「现有文本是原文严格前缀」的截断条目；
// 仅覆盖题干/选项/解析文本，答案、题号、分类不动，学习进度（按题号索引）因此不受影响。
const squash = (s) => String(s ?? "").replace(/\s+/g, "");

// 幂等：已修复的题再跑一次返回 0；目标文本不是现有文本的延续时抛错，绝不静默改写。
export function applyCorrections(questions, fixes) {
  const n = { q: 0, o: 0, x: 0 };
  for (const q of questions) {
    const f = fixes && fixes[q.i];
    if (!f) continue;
    if (f.q && squash(q.q) !== squash(f.q.to)) {
      if (!squash(f.q.to).startsWith(squash(q.q))) throw new Error(`题目 ${q.i} 题干与修复数据冲突`);
      q.q = f.q.to;
      n.q++;
    }
    if (f.o) {
      for (const o of q.o) {
        const fix = f.o[o.k];
        if (!fix || squash(o.t) === squash(fix.to)) continue;
        if (!squash(fix.to).startsWith(squash(o.t))) throw new Error(`题目 ${q.i} 选项 ${o.k} 与修复数据冲突`);
        o.t = fix.to;
        n.o++;
      }
    }
    if (f.x && squash(q.x) !== squash(f.x.to)) {
      const cur = squash(q.x);
      if (cur && !squash(f.x.to).startsWith(cur)) throw new Error(`题目 ${q.i} 解析与修复数据冲突`);
      q.x = f.x.to;
      n.x++;
    }
  }
  return n;
}

// 安全版：题库可能被用户导入替换过，凡文本不是原文前缀的条目一律跳过，
// 因此对非内置题库调用不会产生任何改动（返回全 0）。
export function applyCorrectionsSafe(questions, fixes) {
  const n = { q: 0, o: 0, x: 0 };
  for (const q of questions) {
    const f = fixes && fixes[q.i];
    if (!f || !q || typeof q.q !== "string" || !Array.isArray(q.o)) continue;
    if (f.q && squash(q.q) !== squash(f.q.to) && squash(f.q.to).startsWith(squash(q.q))) {
      q.q = f.q.to;
      n.q++;
    }
    if (f.o) {
      for (const o of q.o) {
        const fix = f.o[o.k];
        if (!fix || typeof o.t !== "string" || squash(o.t) === squash(fix.to)) continue;
        if (!squash(fix.to).startsWith(squash(o.t))) continue;
        o.t = fix.to;
        n.o++;
      }
    }
    if (f.x && squash(q.x) !== squash(f.x.to)) {
      const cur = squash(q.x);
      if (cur && !squash(f.x.to).startsWith(cur)) continue;
      q.x = f.x.to;
      n.x++;
    }
  }
  return n;
}
