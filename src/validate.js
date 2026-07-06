import { monthLabel, addMonth, yen } from "./utils.js";

// 実績月データの整合性チェック
// - income - expense = endBalance - startBalance
// - startBalance + Σ取引金額 = endBalance(明細がある場合)
// - 各取引の「取引後残高」の連鎖
// - カテゴリ合計 = expense
// - 残高連鎖:前月末残高 = 当月月初残高(連続する月のみ)
// 戻り値: [{ month, text }] の配列(問題がなければ空)
export function validateMonths(months) {
  const warnings = [];
  const push = (month, text) => warnings.push({ month, text });
  const sorted = [...months]
    .filter((m) => m.type !== "forecast")
    .sort((a, b) => a.month.localeCompare(b.month));

  let prev = null;
  for (const m of sorted) {
    const label = monthLabel(m.month);
    const income = Number(m.income) || 0;
    const expense = Number(m.expense) || 0;
    const cf = income - expense;

    // 入出金とCFの整合
    if (m.startBalance != null && m.endBalance != null) {
      const expected = m.startBalance + cf;
      if (expected !== m.endBalance) {
        push(m.month,
          `${label}: 月初残高+CF(${yen(expected)})と月末残高(${yen(m.endBalance)})が一致しません(差 ${yen(Math.abs(expected - m.endBalance))})`);
      }
    }

    // 明細合計と残高差の整合 + 取引後残高の連鎖
    if (Array.isArray(m.transactions) && m.transactions.length > 0) {
      const tSum = m.transactions.reduce((s, t) => s + (Number(t.amount) || 0), 0);
      if (m.startBalance != null && m.endBalance != null) {
        const expected = m.startBalance + tSum;
        if (expected !== m.endBalance) {
          push(m.month,
            `${label}: 明細の合計から計算した月末残高(${yen(expected)})が記載の月末残高(${yen(m.endBalance)})と一致しません`);
        }
      }
      if (m.startBalance != null) {
        let bal = m.startBalance;
        for (const t of m.transactions) {
          bal += Number(t.amount) || 0;
          if (t.balance != null && t.balance !== bal) {
            push(m.month,
              `${label} ${t.date}「${t.name}」: 取引後残高が不一致(計算値 ${yen(bal)} / 記載 ${yen(t.balance)})`);
            bal = t.balance; // 以降は記載値を基準に続行(連鎖エラーの多重報告を防ぐ)
          }
        }
      }
    }

    // カテゴリ合計 = 出金
    if (m.categories && Object.keys(m.categories).length > 0 && m.expense != null) {
      const cSum = Object.values(m.categories).reduce((s, v) => s + (Number(v) || 0), 0);
      if (cSum !== expense) {
        push(m.month,
          `${label}: カテゴリ合計(${yen(cSum)})が出金(${yen(expense)})と一致しません(差 ${yen(Math.abs(cSum - expense))})`);
      }
    }

    // 残高連鎖(前月末 = 当月初)。連続する月かつ両方に残高がある場合のみ
    if (prev && addMonth(prev.month, 1) === m.month &&
        prev.endBalance != null && m.startBalance != null &&
        prev.endBalance !== m.startBalance) {
      push(m.month,
        `${monthLabel(prev.month)}の月末残高(${yen(prev.endBalance)})と${label}の月初残高(${yen(m.startBalance)})が一致しません`);
    }
    prev = m;
  }
  return warnings;
}
