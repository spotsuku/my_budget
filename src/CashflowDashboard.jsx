import { useState, useEffect, useMemo } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Cell, Legend,
} from "recharts";
import { INITIAL_MONTHS, INITIAL_ASSUMPTIONS, SUB_ACCOUNTS, STORAGE_KEY } from "./data.js";
import {
  yen, yenSigned, monthLabel, addMonth, sum, nameMatch,
  toCsv, toTsv, downloadFile, copyToClipboard,
} from "./utils.js";
import { validateMonths } from "./validate.js";

// ---------- メイン ----------
export default function CashflowDashboard() {
  const [months, setMonths] = useState(INITIAL_MONTHS);
  const [assumptions, setAssumptions] = useState(INITIAL_ASSUMPTIONS);
  const [loaded, setLoaded] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState(null);
  const [selected, setSelected] = useState("2026-06");
  const [saveState, setSaveState] = useState("idle");
  const [showForecast, setShowForecast] = useState(true);
  const [copyMsg, setCopyMsg] = useState(null);

  // 読み込み(旧形式 {income, expense} からの移行対応)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.months && d.months.length) {
          // 初期データ(過去実績)と保存データをマージ。
          // 通常は保存データ優先だが、初期データ側のrev(改訂番号)が新しい月は初期データで上書き
          const map = new Map(INITIAL_MONTHS.map((m) => [m.month, m]));
          for (const m of d.months) {
            const init = map.get(m.month);
            if (!init || (m.rev || 0) >= (init.rev || 0)) map.set(m.month, m);
          }
          const merged = [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
          setMonths(merged);
          setSelected(merged[merged.length - 1].month);
        }
        if (d.assumptions) {
          if (d.assumptions.fixedCosts) {
            // 旧バージョンの保存データにないフィールド(資産リスト・単発支出)は初期値を補う
            setAssumptions({
              ...d.assumptions,
              assetBudgets: d.assumptions.assetBudgets ?? INITIAL_ASSUMPTIONS.assetBudgets,
              oneOffs: d.assumptions.oneOffs ?? [],
            });
          } else {
            setAssumptions({ ...INITIAL_ASSUMPTIONS, income: d.assumptions.income ?? 560000 });
          }
        }
      }
    } catch (e) { /* 初回はキーなし or 壊れたJSON → 初期値で開始 */ }
    setLoaded(true);
  }, []);

  // 保存
  useEffect(() => {
    if (!loaded) return;
    try {
      setSaveState("saving");
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ months, assumptions }));
      setSaveState("saved");
      const t = setTimeout(() => setSaveState("idle"), 1500);
      return () => clearTimeout(t);
    } catch (e) { setSaveState("error"); }
  }, [months, assumptions, loaded]);

  const fixedTotal = useMemo(() => sum(assumptions.fixedCosts), [assumptions]);
  const varTotal = useMemo(() => sum(assumptions.variableBudgets), [assumptions]);
  const assetTotal = useMemo(() => sum(assumptions.assetBudgets || []), [assumptions]);
  // budgetExpense は銀行からの出金合計(資産への移動を含む)。銀行残高の予測はこちらで行う
  const budgetExpense = fixedTotal + varTotal + assetTotal;
  const budgetCF = assumptions.income - budgetExpense;
  // 資産移動を除いた「消費ベース」のCF(家計として黒字かどうかはこちらで判断)
  const consumptionCF = assumptions.income - fixedTotal - varTotal;

  // 資産項目(楽天証券・自己口座など)。match があれば摘要とのマッチングに使う
  const assetItems = useMemo(
    () => (assumptions.assetBudgets || []).filter((b) => b.name),
    [assumptions]
  );
  const assetOutOf = (m) => {
    let s = 0;
    for (const [cn, cv] of Object.entries(m?.categories || {}))
      if (assetItems.some((b) => nameMatch(b.match || b.name, cn))) s += cv;
    return s;
  };

  // 資産への移動の月次集計(出金=資産へ / 入金=資産から戻り)。通帳ベースの入出金は変更しない
  const assetStats = useMemo(() => {
    const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
    const totals = assetItems.map((b) => ({ name: b.name, out: 0, in: 0 }));
    const perMonth = [];
    for (const m of sorted) {
      let out = 0, inn = 0;
      assetItems.forEach((b, i) => {
        const key = b.match || b.name;
        let o = 0, v = 0;
        for (const [cn, cv] of Object.entries(m.categories || {})) if (nameMatch(key, cn)) o += cv;
        for (const [dn, dv] of Object.entries(m.incomeDetail || {})) if (nameMatch(key, dn)) v += dv;
        totals[i].out += o; totals[i].in += v;
        out += o; inn += v;
      });
      if (out || inn) perMonth.push({ month: m.month, out, in: inn, net: out - inn });
    }
    const totalOut = totals.reduce((s, t) => s + t.out, 0);
    const totalIn = totals.reduce((s, t) => s + t.in, 0);
    return { perMonth, totals, totalOut, totalIn, net: totalOut - totalIn };
  }, [months, assetItems]);

  // 投資項目 = 資産項目のうちサブ口座(ゆうちょ等の現預金)に対応しないもの(楽天証券など)
  const investItems = useMemo(
    () => assetItems.filter(
      (b) => !SUB_ACCOUNTS.some((acc) => acc.match && nameMatch(acc.match, b.match || b.name))
    ),
    [assetItems]
  );

  // 投資への純移動の累計(月末時点)。移動額ベースで評価額(時価)ではない
  const investCumByMonth = useMemo(() => {
    const map = new Map();
    const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
    let cum = 0;
    for (const m of sorted) {
      for (const b of investItems) {
        const key = b.match || b.name;
        for (const [cn, cv] of Object.entries(m.categories || {})) if (nameMatch(key, cn)) cum += cv;
        for (const [dn, dv] of Object.entries(m.incomeDetail || {})) if (nameMatch(key, dn)) cum -= dv;
      }
      map.set(m.month, cum);
    }
    return map;
  }, [months, investItems]);

  // サブ口座(ゆうちょ)の月末残高。判明前の月は最初の月初残高、判明後は直近の月末残高で補完
  const subBalanceAt = (month) => {
    let total = 0;
    for (const acc of SUB_ACCOUNTS) {
      const ms = acc.months;
      if (!ms.length) continue;
      let bal = ms[0].startBalance ?? 0;
      for (const mm of ms) if (mm.month <= month) bal = mm.endBalance;
      total += bal;
    }
    return total;
  };

  // 全実績データの整合性チェック(取込・削除のたびに再計算)。サブ口座(ゆうちょ)も同じルールで検証
  const validationWarnings = useMemo(() => {
    const main = validateMonths(months);
    const sub = SUB_ACCOUNTS.flatMap((acc) =>
      validateMonths(acc.months).map((w) => ({ ...w, text: `[${acc.name}] ${w.text}` }))
    );
    return [...main, ...sub];
  }, [months]);

  // 実績+12ヶ月予測を合成。予測月には登録済みの単発支出を上乗せする
  const rows = useMemo(() => {
    const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
    const out = sorted.map((m) => ({
      ...m,
      cf: (m.income ?? 0) - (m.expense ?? 0),
    }));
    const last = out[out.length - 1];
    if (!last) return out;
    const oneOffsByMonth = new Map();
    for (const o of assumptions.oneOffs || []) {
      if (!o.month) continue;
      if (!oneOffsByMonth.has(o.month)) oneOffsByMonth.set(o.month, []);
      oneOffsByMonth.get(o.month).push(o);
    }
    let bal = last.endBalance ?? (last.startBalance + last.cf);
    let cur = last.month;
    for (let i = 1; i <= 12; i++) {
      cur = addMonth(cur, 1);
      const oneOffs = oneOffsByMonth.get(cur) || [];
      const extra = oneOffs.reduce((s, o) => s + (Number(o.amount) || 0), 0);
      const start = bal;
      bal = start + budgetCF - extra;
      out.push({
        month: cur, type: "forecast",
        startBalance: start, endBalance: bal,
        income: assumptions.income, expense: budgetExpense + extra, cf: budgetCF - extra,
        oneOffs,
      });
    }
    return out;
  }, [months, assumptions, budgetExpense, budgetCF]);

  // 実績のみ表示トグル適用後の行(チャート・月次表に使用)
  const displayRows = useMemo(
    () => (showForecast ? rows : rows.filter((r) => r.type === "actual")),
    [rows, showForecast]
  );

  const latestActual = useMemo(() => {
    const a = rows.filter((r) => r.type === "actual");
    return a[a.length - 1] || null;
  }, [rows]);

  const minRow = useMemo(
    () => rows.reduce((m, r) => (r.endBalance < (m?.endBalance ?? Infinity) ? r : m), null),
    [rows]
  );

  // チャート用:みずほ残高に加え、現預金残高(+ゆうちょ)と総資産(現預金+投資移動累計)を系列化
  const chartData = useMemo(() => {
    const investBudget = sum(investItems);
    let lastInvest = 0;
    return displayRows.map((r) => {
      const cash = r.endBalance != null ? r.endBalance + subBalanceAt(r.month) : null;
      let invest;
      if (r.type === "actual") {
        invest = investCumByMonth.get(r.month) ?? lastInvest;
        lastInvest = invest;
      } else {
        invest = lastInvest + investBudget; // 予測期間は投資予算ぶん毎月積み上がる想定
        lastInvest = invest;
      }
      return {
        name: monthLabel(r.month),
        みずほ残高: r.endBalance,
        現預金残高: cash,
        "資産残高(投資)": invest,
        総資産: cash != null ? cash + invest : null,
        月次CF: r.cf,
        type: r.type,
      };
    });
  }, [displayRows, investCumByMonth, investItems]);

  const selRow = rows.find((r) => r.month === selected && r.type === "actual");

  // 予算 vs 実績(選択月)
  const budgetCompare = useMemo(() => {
    if (!selRow?.categories) return null;
    const cats = Object.entries(selRow.categories);
    const used = new Set();
    const items = [...assumptions.fixedCosts.map((b) => ({ ...b, kind: "固定" })),
                   ...assumptions.variableBudgets.map((b) => ({ ...b, kind: "変動" })),
                   ...(assumptions.assetBudgets || []).map((b) => ({ ...b, kind: "資産" }))]
      .map((b) => {
        let actual = 0;
        for (const [cn, cv] of cats) {
          if (!used.has(cn) && nameMatch(b.match || b.name, cn)) { actual += cv; used.add(cn); }
        }
        return { ...b, actual, diff: actual - Number(b.amount || 0) };
      });
    const others = cats.filter(([cn]) => !used.has(cn));
    const otherTotal = others.reduce((s, [, v]) => s + v, 0);
    return { items, others, otherTotal };
  }, [selRow, assumptions]);

  // 項目×月 マトリクス(月次推移)
  const matrix = useMemo(() => {
    const actuals = rows.filter((r) => r.type === "actual");
    const items = [
      ...assumptions.fixedCosts.map((b) => ({ ...b, kind: "固定", values: {} })),
      ...assumptions.variableBudgets.map((b) => ({ ...b, kind: "変動", values: {} })),
      ...(assumptions.assetBudgets || []).map((b) => ({ ...b, kind: "資産", values: {} })),
    ];
    const extraMap = new Map();
    for (const m of actuals) {
      const used = new Set();
      const cats = Object.entries(m.categories || {});
      for (const row of items) {
        let v = 0;
        for (const [cn, cv] of cats) {
          if (!used.has(cn) && nameMatch(row.match || row.name, cn)) { v += cv; used.add(cn); }
        }
        if (v) row.values[m.month] = v;
      }
      for (const [cn, cv] of cats) {
        if (!used.has(cn)) {
          if (!extraMap.has(cn)) extraMap.set(cn, {});
          extraMap.get(cn)[m.month] = cv;
        }
      }
    }
    const extras = [...extraMap.entries()].map(([name, values]) => ({ name, values }));
    return { actuals, items, extras };
  }, [rows, assumptions]);

  // JSON取込(残高連鎖・整合性を自動チェックし、不一致は警告表示)
  const handleImport = () => {
    try {
      const raw = JSON.parse(importText.trim());
      // 単月 / 複数月の配列 / エクスポートしたバックアップ {months, assumptions} のいずれにも対応
      const list = Array.isArray(raw) ? raw : Array.isArray(raw.months) ? raw.months : [raw];
      if (!Array.isArray(raw) && raw.assumptions?.fixedCosts) setAssumptions(raw.assumptions);
      for (const d of list) {
        if (!d.month || d.income == null || d.expense == null)
          throw new Error("month / income / expense は必須です");
      }
      // 取込後の全体像を先に作り、事前に検証する
      const map = new Map(months.map((m) => [m.month, m]));
      for (const d of list) map.set(d.month, { type: "actual", ...map.get(d.month), ...d });
      const merged = [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
      const importedSet = new Set(list.map((d) => d.month));
      const newWarnings = validateMonths(merged).filter((w) => importedSet.has(w.month));

      setMonths(merged);
      setSelected(list[list.length - 1].month);
      setImportText("");
      const label = list.map((d) => monthLabel(d.month)).join("、");
      if (newWarnings.length) {
        setImportMsg({
          ok: false,
          text: `${label} を取り込みましたが、${newWarnings.length}件の不整合があります(下の「データ検証」を確認してください)`,
        });
      } else {
        setImportMsg({ ok: true, text: `${label} の実績を反映しました(検証OK:残高連鎖・入出金整合)` });
      }
    } catch (e) {
      setImportMsg({ ok: false, text: "取込に失敗:" + e.message });
    }
  };

  const handleReset = () => {
    if (!confirm("保存データを消去して初期状態に戻します。よろしいですか?")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    setMonths(INITIAL_MONTHS);
    setAssumptions(INITIAL_ASSUMPTIONS);
    setSelected("2026-06");
  };

  const deleteMonth = (m) => {
    if (!confirm(`${monthLabel(m)} の実績を削除しますか?`)) return;
    setMonths((prev) => prev.filter((x) => x.month !== m));
  };

  // ---------- エクスポート ----------
  const actuals = useMemo(
    () => [...months].sort((a, b) => a.month.localeCompare(b.month)),
    [months]
  );

  const exportJson = () => {
    downloadFile(
      "cashflow-data.json",
      JSON.stringify({ months: actuals, assumptions }, null, 2),
      "application/json"
    );
  };

  const exportSummaryCsv = () => {
    const header = ["月", "月初残高", "入金", "出金", "月次CF", "月末残高"];
    const body = actuals.map((m) => [
      m.month,
      m.startBalance ?? "",
      m.income ?? "",
      m.expense ?? "",
      (m.income ?? 0) - (m.expense ?? 0),
      m.endBalance ?? "",
    ]);
    downloadFile("cashflow-monthly.csv", toCsv([header, ...body]));
  };

  const exportCategoryCsv = () => {
    const body = [["月", "項目", "金額"]];
    for (const m of actuals) {
      for (const [cn, cv] of Object.entries(m.categories || {})) body.push([m.month, cn, cv]);
    }
    downloadFile("cashflow-categories.csv", toCsv(body));
  };

  const exportTransactionsCsv = () => {
    const body = [["月", "日付", "摘要", "金額", "残高"]];
    for (const m of actuals) {
      for (const t of m.transactions || []) body.push([m.month, t.date, t.name, t.amount, t.balance]);
    }
    downloadFile("cashflow-transactions.csv", toCsv(body));
  };

  // マトリクスを表形式(2次元配列)に変換 — CSVダウンロード/クリップボードコピー共用
  const matrixToRows = () => {
    const header = ["項目", "区分", "予算", ...matrix.actuals.map((m) => monthLabel(m.month))];
    const body = [
      ...matrix.items.map((b) => [
        b.name || "(名称未設定)", b.kind, b.amount,
        ...matrix.actuals.map((m) => b.values[m.month] ?? ""),
      ]),
      ...matrix.extras.map((b) => [
        `${b.name}(予算外)`, "", 0,
        ...matrix.actuals.map((m) => b.values[m.month] ?? ""),
      ]),
      ["出金合計", "", budgetExpense, ...matrix.actuals.map((m) => m.expense ?? "")],
      ["うち資産へ", "", assetTotal, ...matrix.actuals.map((m) => assetOutOf(m) || "")],
      ["消費支出(資産移動除く)", "", fixedTotal + varTotal, ...matrix.actuals.map((m) => (m.expense ?? 0) - assetOutOf(m))],
      ["入金", "", assumptions.income, ...matrix.actuals.map((m) => m.income ?? "")],
      ["月次CF", "", budgetCF, ...matrix.actuals.map((m) => m.cf ?? "")],
      ["月末残高", "", "", ...matrix.actuals.map((m) => m.endBalance ?? "")],
    ];
    return [header, ...body];
  };

  const copyMatrix = async () => {
    try {
      await copyToClipboard(toTsv(matrixToRows()));
      setCopyMsg("コピーしました。スプレッドシートにそのまま貼り付けできます");
    } catch (e) {
      setCopyMsg("コピーに失敗しました:" + e.message);
    }
    setTimeout(() => setCopyMsg(null), 3000);
  };

  const downloadMatrixCsv = () => downloadFile("cashflow-matrix.csv", toCsv(matrixToRows()));

  // 予算リスト編集
  const updateBudget = (kind, idx, field, value) => {
    setAssumptions((a) => {
      const key = kind === "fixed" ? "fixedCosts" : kind === "asset" ? "assetBudgets" : "variableBudgets";
      const list = (a[key] || []).map((x, i) =>
        i === idx ? { ...x, [field]: field === "amount" ? Number(value) || 0 : value } : x
      );
      return { ...a, [key]: list };
    });
  };
  const addBudget = (kind) => {
    setAssumptions((a) => {
      const key = kind === "fixed" ? "fixedCosts" : kind === "asset" ? "assetBudgets" : "variableBudgets";
      return { ...a, [key]: [...(a[key] || []), { name: "", amount: 0 }] };
    });
  };
  const removeBudget = (kind, idx) => {
    setAssumptions((a) => {
      const key = kind === "fixed" ? "fixedCosts" : kind === "asset" ? "assetBudgets" : "variableBudgets";
      return { ...a, [key]: (a[key] || []).filter((_, i) => i !== idx) };
    });
  };

  // 単発支出(予定)の編集
  const updateOneOff = (idx, field, value) => {
    setAssumptions((a) => ({
      ...a,
      oneOffs: (a.oneOffs || []).map((x, i) =>
        i === idx ? { ...x, [field]: field === "amount" ? Number(value) || 0 : value } : x
      ),
    }));
  };
  const addOneOff = () => {
    setAssumptions((a) => ({
      ...a,
      oneOffs: [...(a.oneOffs || []), { month: addMonth(latestActual?.month || "2026-06", 1), name: "", amount: 0 }],
    }));
  };
  const removeOneOff = (idx) => {
    setAssumptions((a) => ({ ...a, oneOffs: (a.oneOffs || []).filter((_, i) => i !== idx) }));
  };

  // ---------- スタイル ----------
  const S = {
    page: {
      minHeight: "100vh", background: "#EEF0F6", color: "#141A33",
      fontFamily: "'Hiragino Sans','Yu Gothic UI','Noto Sans JP',sans-serif",
      padding: "0 0 48px",
    },
    header: {
      background: "linear-gradient(135deg,#141A4E 0%,#1E2A78 60%,#28359C 100%)",
      color: "#fff", padding: "28px 24px 88px",
    },
    wrap: { maxWidth: 1060, margin: "0 auto", padding: "0 16px" },
    kpiRow: {
      maxWidth: 1060, margin: "-64px auto 0", padding: "0 16px",
      display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12,
    },
    card: {
      background: "#fff", borderRadius: 14, padding: "18px 20px",
      boxShadow: "0 4px 18px rgba(20,26,78,.08)",
    },
    section: { maxWidth: 1060, margin: "20px auto 0", padding: "0 16px" },
    h2: { fontSize: 17, fontWeight: 700, letterSpacing: ".04em", margin: "0 0 12px", color: "#141A4E" },
    label: { fontSize: 12.5, color: "#6A7190", letterSpacing: ".08em", marginBottom: 6 },
    big: { fontSize: 30, fontWeight: 800, fontVariantNumeric: "tabular-nums" },
    tag: (t) => ({
      display: "inline-block", fontSize: 11.5, fontWeight: 700, padding: "2px 8px",
      borderRadius: 999, letterSpacing: ".06em",
      background: t === "actual" ? "#E2F5EC" : "#EDEFFA",
      color: t === "actual" ? "#0B7A50" : "#3A47B8",
    }),
    kindTag: (k) => ({
      display: "inline-block", fontSize: 11.5, fontWeight: 700, padding: "2px 8px",
      borderRadius: 999,
      background: k === "固定" ? "#E8ECFB" : k === "資産" ? "#E2F5EC" : "#FFF1E4",
      color: k === "固定" ? "#2F3DA8" : k === "資産" ? "#0B7A50" : "#B25E12",
    }),
    th: {
      textAlign: "right", padding: "8px 10px", fontSize: 12.5, color: "#6A7190",
      borderBottom: "1px solid #E4E7F0", whiteSpace: "nowrap",
      // 縦スクロール時にヘッダー行を固定(各表はスクロールコンテナで包む)
      position: "sticky", top: 0, background: "#fff", zIndex: 2,
    },
    scrollY: { maxHeight: 440, overflow: "auto" },
    td: {
      textAlign: "right", padding: "9px 10px", fontSize: 14,
      borderBottom: "1px solid #F0F2F8", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
    },
    input: {
      padding: "7px 10px", borderRadius: 8, border: "1px solid #D6DAE8",
      fontSize: 14, boxSizing: "border-box",
    },
    btn: {
      background: "#1E2A78", color: "#fff", border: "none", borderRadius: 8,
      padding: "9px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer",
    },
    btnGhost: {
      background: "transparent", color: "#B23A48", border: "1px solid #E4B4BB",
      borderRadius: 8, padding: "7px 14px", fontSize: 13, cursor: "pointer",
    },
    btnAdd: {
      background: "#F0F2FB", color: "#1E2A78", border: "1px dashed #B9C1E8",
      borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer",
    },
    btnLight: {
      background: "#F0F2FB", color: "#1E2A78", border: "1px solid #C6CDEB",
      borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer",
    },
    toggleLabel: {
      display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13,
      color: "#3A4160", cursor: "pointer", userSelect: "none",
    },
  };

  const BudgetList = ({ kind, title, list, total, accent }) => (
    <div style={{ flex: 1, minWidth: 300 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#141A4E" }}>{title}</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: accent, fontVariantNumeric: "tabular-nums" }}>
          計 {yen(total)}
        </div>
      </div>
      {list.map((b, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
          <input style={{ ...S.input, flex: 1, minWidth: 0 }} value={b.name} placeholder="項目名"
            onChange={(e) => updateBudget(kind, i, "name", e.target.value)} />
          <input style={{ ...S.input, width: 110, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
            type="number" step={1000} value={b.amount}
            onChange={(e) => updateBudget(kind, i, "amount", e.target.value)} />
          <button onClick={() => removeBudget(kind, i)}
            style={{ background: "none", border: "none", color: "#B23A48", cursor: "pointer", fontSize: 17, padding: "0 4px" }}
            aria-label="削除">×</button>
        </div>
      ))}
      <button style={S.btnAdd} onClick={() => addBudget(kind)}>+ 項目を追加</button>
    </div>
  );

  return (
    <div style={S.page}>
      {/* ヘッダー */}
      <div style={S.header}>
        <div style={S.wrap}>
          <div style={{ fontSize: 12.5, letterSpacing: ".2em", opacity: 0.75 }}>みずほ銀行 本郷支店 普通 4104341</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>資金繰りダッシュボード</h1>
            <span style={{ fontSize: 13, opacity: 0.8 }}>
              {saveState === "saving" ? "保存中…" : saveState === "saved" ? "✓ 保存済み" : saveState === "error" ? "⚠ 保存エラー" : ""}
            </span>
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            毎月のスクショ読取結果を取り込むと、実績と向こう12ヶ月の予測が更新されます
          </div>
        </div>
      </div>

      {/* KPI */}
      <div style={S.kpiRow}>
        <div style={S.card}>
          <div style={S.label}>最新実績月</div>
          <div style={{ ...S.big, fontSize: 24 }}>{latestActual ? monthLabel(latestActual.month) : "—"}</div>
          <span style={S.tag("actual")}>実績</span>
        </div>
        <div style={S.card}>
          <div style={S.label}>月初残高 → 月末残高</div>
          <div style={{ ...S.big, fontSize: 22 }}>
            {yen(latestActual?.startBalance)} →<br />{yen(latestActual?.endBalance)}
          </div>
        </div>
        <div style={S.card}>
          <div style={S.label}>当月キャッシュフロー</div>
          <div style={{ ...S.big, color: (latestActual?.cf ?? 0) < 0 ? "#C13A55" : "#0B7A50" }}>
            {yenSigned(latestActual?.cf)}
          </div>
          <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 4 }}>
            入金 {yen(latestActual?.income)} / 出金 {yen(latestActual?.expense)}
          </div>
          {latestActual && assetOutOf(latestActual) > 0 && (
            <div style={{ fontSize: 12.5, color: "#0B7A50", marginTop: 2 }}>
              出金のうち資産へ {yen(assetOutOf(latestActual))}(消費は {yen((latestActual.expense ?? 0) - assetOutOf(latestActual))})
            </div>
          )}
        </div>
        <div style={S.card}>
          <div style={S.label}>予算ベースの月次CF</div>
          <div style={{ ...S.big, color: budgetCF < 0 ? "#C13A55" : "#0B7A50" }}>{yenSigned(budgetCF)}</div>
          <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 4 }}>
            固定 {yen(fixedTotal)} + 変動 {yen(varTotal)} + 資産へ {yen(assetTotal)}
          </div>
        </div>
        <div style={S.card}>
          <div style={S.label}>予測期間の最低残高</div>
          <div style={{ ...S.big, color: (minRow?.endBalance ?? 0) < 100000 ? "#C13A55" : "#141A33" }}>
            {yen(minRow?.endBalance)}
          </div>
          <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 4 }}>
            {minRow ? monthLabel(minRow.month) + " 時点" : ""}
            {minRow && minRow.endBalance < 0 && " ⚠ 資金ショート見込み"}
          </div>
        </div>
        <div style={S.card}>
          <div style={S.label}>現預金残高(判明分)</div>
          <div style={{ ...S.big, fontSize: 24, color: "#0E7A8A" }}>
            {latestActual ? yen((latestActual.endBalance ?? 0) + subBalanceAt(latestActual.month)) : "—"}
          </div>
          <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 4 }}>
            みずほ {yen(latestActual?.endBalance)} + ゆうちょ {latestActual ? yen(subBalanceAt(latestActual.month)) : "—"}
          </div>
        </div>
        <div style={S.card}>
          <div style={S.label}>総資産(現預金+投資)</div>
          <div style={{ ...S.big, fontSize: 24, color: "#0B7A50" }}>
            {latestActual ? yen((latestActual.endBalance ?? 0) + subBalanceAt(latestActual.month) + (investCumByMonth.get(latestActual.month) ?? 0)) : "—"}
          </div>
          <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 4 }}>
            投資への純移動累計 {yenSigned(investCumByMonth.get(latestActual?.month) ?? 0)}(評価額ではない)
          </div>
        </div>
      </div>

      {/* データ検証(不整合があるときだけ表示) */}
      {validationWarnings.length > 0 && (
        <div style={S.section}>
          <div style={{ ...S.card, background: "#FDF6F0", border: "1px solid #F0D8C0" }}>
            <h2 style={{ ...S.h2, color: "#9A5B12" }}>⚠ データ検証:{validationWarnings.length}件の不整合</h2>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.9, color: "#7A4A10" }}>
              {validationWarnings.map((w, i) => <li key={i}>{w.text}</li>)}
            </ul>
            <div style={{ fontSize: 12.5, color: "#9A7B50", marginTop: 8 }}>
              チェック内容:前月末残高=当月月初残高 / 月初+入金−出金=月末 / 明細合計と残高の連鎖 / カテゴリ合計=出金
            </div>
          </div>
        </div>
      )}

      {/* チャート */}
      <div style={S.section}>
        <div style={{ ...S.card, padding: "20px 12px 8px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", paddingLeft: 20, paddingRight: 12 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>残高推移と月次CF{showForecast ? "(実績 + 12ヶ月予測)" : "(実績のみ)"}</h2>
            <label style={S.toggleLabel}>
              <input type="checkbox" checked={!showForecast}
                onChange={(e) => setShowForecast(!e.target.checked)} />
              実績のみ表示
            </label>
          </div>
          <div style={{ width: "100%", height: 320, marginTop: 10 }}>
            <ResponsiveContainer>
              <ComposedChart data={chartData} margin={{ top: 6, right: 14, left: 6, bottom: 0 }}>
                <CartesianGrid stroke="#EDEFF5" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11.5 }} interval={0} angle={-38} height={54} textAnchor="end" />
                <YAxis tick={{ fontSize: 11.5 }} tickFormatter={(v) => (v / 10000).toFixed(0) + "万"} width={44} />
                <Tooltip formatter={(v, n) => [yen(v), n]} labelStyle={{ fontWeight: 700 }} />
                <Legend wrapperStyle={{ fontSize: 12.5 }} />
                <ReferenceLine y={0} stroke="#C13A55" strokeDasharray="4 4" />
                <Bar dataKey="月次CF" barSize={14} radius={[3, 3, 0, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i}
                      fill={d.月次CF < 0 ? "#E8A0AE" : "#9FD8BE"}
                      opacity={d.type === "forecast" ? 0.55 : 1} />
                  ))}
                </Bar>
                <Line dataKey="みずほ残高" stroke="#1E2A78" strokeWidth={2.4}
                  dot={(p) => {
                    const f = chartData[p.index]?.type === "forecast";
                    return <circle key={p.index} cx={p.cx} cy={p.cy} r={3.2}
                      fill={f ? "#fff" : "#1E2A78"} stroke="#1E2A78" strokeWidth={1.6} />;
                  }} />
                <Line dataKey="現預金残高" stroke="#0E7A8A" strokeWidth={2} dot={false} />
                {/* ツールチップ表示専用の系列(線は描画しない) */}
                <Line dataKey="資産残高(投資)" stroke="#6B4FA8" strokeWidth={0} dot={false} activeDot={false} legendType="none" />
                <Line dataKey="総資産" stroke="#0B7A50" strokeWidth={2} strokeDasharray="6 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 12.5, color: "#6A7190", padding: "4px 0 10px 20px" }}>
            ○ 白抜きの点・薄い棒 = 予測(予算合計から計算)/ 赤点線 = 残高ゼロライン<br />
            現預金残高 = みずほ + ゆうちょ / 総資産(緑破線)= 現預金 + 投資への純移動累計(評価額ではなく移動額ベース)
          </div>
        </div>
      </div>

      {/* 予算設定 */}
      <div style={S.section}>
        <div style={S.card}>
          <h2 style={S.h2}>予算設定(向こう12ヶ月の予測に適用)</h2>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 18 }}>
            <div>
              <div style={S.label}>月次入金の想定</div>
              <input style={{ ...S.input, width: 140, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                type="number" step={10000} value={assumptions.income}
                onChange={(e) => setAssumptions((a) => ({ ...a, income: Number(e.target.value) || 0 }))} />
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.9 }}>
              出金予算合計:<b>{yen(budgetExpense)}</b>(固定 {yen(fixedTotal)} / 変動 {yen(varTotal)} / 資産へ {yen(assetTotal)})<br />
              予算どおりなら銀行残高の月次CF:<b style={{ color: budgetCF < 0 ? "#C13A55" : "#0B7A50" }}>{yenSigned(budgetCF)}</b>
              <span style={{ fontSize: 13, color: "#6A7190" }}>(資産移動を除く消費ベース:
                <b style={{ color: consumptionCF < 0 ? "#C13A55" : "#0B7A50" }}>{yenSigned(consumptionCF)}</b>)</span>
              {consumptionCF < 0 && <span style={{ color: "#C13A55", fontSize: 13 }}> ← 予算段階で赤字です。変動費の見直しを</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
            <BudgetList kind="fixed" title="固定費" list={assumptions.fixedCosts} total={fixedTotal} accent="#2F3DA8" />
            <BudgetList kind="variable" title="変動費(予算)" list={assumptions.variableBudgets} total={varTotal} accent="#B25E12" />
            <BudgetList kind="asset" title="資産へ(投資・自己口座)" list={assumptions.assetBudgets || []} total={assetTotal} accent="#0B7A50" />
          </div>

          {/* 単発支出(予定) */}
          <div style={{ marginTop: 24, borderTop: "1px solid #E4E7F0", paddingTop: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#141A4E", marginBottom: 4 }}>単発支出(予定)</div>
            <div style={{ fontSize: 13, color: "#6A7190", marginBottom: 10 }}>
              車検・旅行・家電の買い替えなど、毎月ではない支出の予定。指定した月の予測出金に上乗せされ、残高予測・最低残高に反映されます(実績月には影響しません)
            </div>
            {(assumptions.oneOffs || []).map((o, i) => {
              const isPast = latestActual && o.month && o.month <= latestActual.month;
              return (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="month" style={{ ...S.input, width: 150 }} value={o.month || ""}
                    onChange={(e) => updateOneOff(i, "month", e.target.value)} />
                  <input style={{ ...S.input, flex: 1, minWidth: 160 }} value={o.name} placeholder="内容(例:車検)"
                    onChange={(e) => updateOneOff(i, "name", e.target.value)} />
                  <input style={{ ...S.input, width: 120, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    type="number" step={10000} value={o.amount}
                    onChange={(e) => updateOneOff(i, "amount", e.target.value)} />
                  <button onClick={() => removeOneOff(i)}
                    style={{ background: "none", border: "none", color: "#B23A48", cursor: "pointer", fontSize: 17, padding: "0 4px" }}
                    aria-label="削除">×</button>
                  {isPast && <span style={{ fontSize: 12.5, color: "#C13A55" }}>過去月のため予測に反映されません</span>}
                </div>
              );
            })}
            <button style={S.btnAdd} onClick={addOneOff}>+ 単発支出を追加</button>
          </div>
        </div>
      </div>

      {/* 予算 vs 実績 */}
      {budgetCompare && selRow && (
        <div style={S.section}>
          <div style={{ ...S.card, overflowX: "auto" }}>
            <h2 style={S.h2}>{monthLabel(selRow.month)} 予算 vs 実績(下の表で実績行をクリックすると切替)</h2>
            <div style={S.scrollY}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
              <thead>
                <tr>
                  <th style={{ ...S.th, textAlign: "left" }}>項目</th>
                  <th style={S.th}>区分</th>
                  <th style={S.th}>予算</th>
                  <th style={S.th}>実績</th>
                  <th style={S.th}>差異</th>
                </tr>
              </thead>
              <tbody>
                {budgetCompare.items.map((b, i) => (
                  <tr key={i} style={{ background: b.diff > 0 ? "#FDF3F5" : "transparent" }}>
                    <td style={{ ...S.td, textAlign: "left", fontWeight: 600 }}>{b.name || "(名称未設定)"}</td>
                    <td style={S.td}><span style={S.kindTag(b.kind)}>{b.kind}</span></td>
                    <td style={S.td}>{yen(b.amount)}</td>
                    <td style={S.td}>{yen(b.actual)}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: b.diff > 0 ? "#C13A55" : "#0B7A50" }}>
                      {b.diff > 0 ? "+" + yen(b.diff).slice(1) + " 超過" : yenSigned(b.diff)}
                    </td>
                  </tr>
                ))}
                {budgetCompare.others.map(([cn, cv]) => (
                  <tr key={cn} style={{ background: "#FBF9F3" }}>
                    <td style={{ ...S.td, textAlign: "left", color: "#8A6D1F" }}>{cn}(予算外)</td>
                    <td style={S.td}>—</td>
                    <td style={S.td}>¥0</td>
                    <td style={S.td}>{yen(cv)}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: "#C13A55" }}>+{yen(cv).slice(1)} 超過</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...S.td, textAlign: "left", fontWeight: 800, borderTop: "2px solid #E4E7F0" }}>合計</td>
                  <td style={{ ...S.td, borderTop: "2px solid #E4E7F0" }}></td>
                  <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0" }}>{yen(budgetExpense)}</td>
                  <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0" }}>{yen(selRow.expense)}</td>
                  <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0",
                    color: selRow.expense - budgetExpense > 0 ? "#C13A55" : "#0B7A50" }}>
                    {yenSigned(selRow.expense - budgetExpense)}
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}

      {/* 項目別 月次推移(マトリクス) */}
      {matrix.actuals.length > 0 && (
        <div style={S.section}>
          <div style={{ ...S.card, overflowX: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ ...S.h2, margin: 0 }}>項目別 月次推移(実績)</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {copyMsg && <span style={{ fontSize: 12.5, color: "#0B7A50" }}>{copyMsg}</span>}
                <button style={S.btnLight} onClick={copyMatrix}>表をコピー(スプレッドシート貼付用)</button>
                <button style={S.btnLight} onClick={downloadMatrixCsv}>CSVダウンロード</button>
              </div>
            </div>
            <div style={{ ...S.scrollY, marginTop: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 + matrix.actuals.length * 110 }}>
              <thead>
                <tr>
                  <th style={{ ...S.th, textAlign: "left", position: "sticky", left: 0, background: "#fff", zIndex: 3 }}>項目</th>
                  <th style={S.th}>区分</th>
                  <th style={S.th}>予算</th>
                  {matrix.actuals.map((m) => (
                    <th key={m.month} style={{ ...S.th, fontWeight: 700, color: "#141A4E" }}>{monthLabel(m.month)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.items.map((b, i) => (
                  <tr key={"b" + i}>
                    <td style={{ ...S.td, textAlign: "left", fontWeight: 600, position: "sticky", left: 0, background: "#fff" }}>
                      {b.name || "(名称未設定)"}
                    </td>
                    <td style={S.td}><span style={S.kindTag(b.kind)}>{b.kind}</span></td>
                    <td style={{ ...S.td, color: "#6A7190" }}>{yen(b.amount)}</td>
                    {matrix.actuals.map((m) => {
                      const v = b.values[m.month];
                      const over = v != null && v > Number(b.amount || 0);
                      return (
                        <td key={m.month} style={{ ...S.td, background: over ? "#FDF3F5" : "transparent",
                          color: over ? "#C13A55" : "#141A33", fontWeight: over ? 700 : 400 }}>
                          {v != null ? yen(v) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {matrix.extras.map((b, i) => (
                  <tr key={"e" + i} style={{ background: "#FBF9F3" }}>
                    <td style={{ ...S.td, textAlign: "left", color: "#8A6D1F", position: "sticky", left: 0, background: "#FBF9F3" }}>
                      {b.name}(予算外)
                    </td>
                    <td style={S.td}>—</td>
                    <td style={{ ...S.td, color: "#6A7190" }}>¥0</td>
                    {matrix.actuals.map((m) => (
                      <td key={m.month} style={{ ...S.td, color: "#C13A55", fontWeight: 600 }}>
                        {b.values[m.month] != null ? yen(b.values[m.month]) : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td style={{ ...S.td, textAlign: "left", fontWeight: 800, borderTop: "2px solid #E4E7F0", position: "sticky", left: 0, background: "#fff" }}>出金合計</td>
                  <td style={{ ...S.td, borderTop: "2px solid #E4E7F0" }}></td>
                  <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0" }}>{yen(budgetExpense)}</td>
                  {matrix.actuals.map((m) => (
                    <td key={m.month} style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0", color: "#C13A55" }}>{yen(m.expense)}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ ...S.td, textAlign: "left", position: "sticky", left: 0, background: "#fff", color: "#0B7A50" }}>うち資産へ</td>
                  <td style={S.td}></td>
                  <td style={{ ...S.td, color: "#0B7A50" }}>{yen(assetTotal)}</td>
                  {matrix.actuals.map((m) => (
                    <td key={m.month} style={{ ...S.td, color: "#0B7A50" }}>{assetOutOf(m) ? yen(assetOutOf(m)) : "—"}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ ...S.td, textAlign: "left", position: "sticky", left: 0, background: "#fff" }}>消費支出(資産移動除く)</td>
                  <td style={S.td}></td>
                  <td style={S.td}>{yen(fixedTotal + varTotal)}</td>
                  {matrix.actuals.map((m) => (
                    <td key={m.month} style={S.td}>{yen((m.expense ?? 0) - assetOutOf(m))}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ ...S.td, textAlign: "left", fontWeight: 800, position: "sticky", left: 0, background: "#fff" }}>入金</td>
                  <td style={S.td}></td>
                  <td style={{ ...S.td, fontWeight: 800 }}>{yen(assumptions.income)}</td>
                  {matrix.actuals.map((m) => (
                    <td key={m.month} style={{ ...S.td, fontWeight: 800, color: "#0B7A50" }}>{yen(m.income)}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ ...S.td, textAlign: "left", fontWeight: 800, position: "sticky", left: 0, background: "#fff" }}>月次CF</td>
                  <td style={S.td}></td>
                  <td style={{ ...S.td, fontWeight: 800, color: budgetCF < 0 ? "#C13A55" : "#0B7A50" }}>{yenSigned(budgetCF)}</td>
                  {matrix.actuals.map((m) => (
                    <td key={m.month} style={{ ...S.td, fontWeight: 800, color: m.cf < 0 ? "#C13A55" : "#0B7A50" }}>{yenSigned(m.cf)}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ ...S.td, textAlign: "left", fontWeight: 800, position: "sticky", left: 0, background: "#fff" }}>月末残高</td>
                  <td style={S.td}></td>
                  <td style={S.td}>—</td>
                  {matrix.actuals.map((m) => (
                    <td key={m.month} style={{ ...S.td, fontWeight: 800, color: m.endBalance < 0 ? "#C13A55" : "#141A33" }}>{yen(m.endBalance)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
            </div>
            <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 8 }}>
              毎月データを取り込むと右に列が増えていきます。赤いセル = 予算超過
            </div>
          </div>
        </div>
      )}

      {/* 取引明細 */}
      {selRow?.transactions?.length > 0 && (
        <div style={S.section}>
          <div style={{ ...S.card, overflowX: "auto" }}>
            <h2 style={S.h2}>{monthLabel(selRow.month)} 取引明細({selRow.transactions.length}件)</h2>
            <div style={{ maxHeight: 380, overflowY: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, textAlign: "left", position: "sticky", top: 0, background: "#fff" }}>日付</th>
                    <th style={{ ...S.th, textAlign: "left", position: "sticky", top: 0, background: "#fff" }}>摘要</th>
                    <th style={{ ...S.th, position: "sticky", top: 0, background: "#fff" }}>金額</th>
                    <th style={{ ...S.th, position: "sticky", top: 0, background: "#fff" }}>残高</th>
                  </tr>
                </thead>
                <tbody>
                  {selRow.transactions.map((t, i) => (
                    <tr key={i}>
                      <td style={{ ...S.td, textAlign: "left", color: "#6A7190", fontSize: 13 }}>
                        {selRow.month.split("-")[0].slice(2)}/{t.date.replace("-", "/").replace(/^0/, "").replace("/0", "/")}
                      </td>
                      <td style={{ ...S.td, textAlign: "left" }}>{t.name}</td>
                      <td style={{ ...S.td, fontWeight: 700, color: t.amount < 0 ? "#C13A55" : "#0B7A50" }}>
                        {yenSigned(t.amount)}
                      </td>
                      <td style={{ ...S.td, color: "#6A7190" }}>{yen(t.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 8 }}>
              月次資金繰り表の実績行をクリックすると、表示する月を切り替えられます
            </div>
          </div>
        </div>
      )}

      {/* 月次テーブル */}
      <div style={S.section}>
        <div style={{ ...S.card, overflowX: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
            <h2 style={{ ...S.h2, margin: 0 }}>月次資金繰り表</h2>
            <label style={S.toggleLabel}>
              <input type="checkbox" checked={!showForecast}
                onChange={(e) => setShowForecast(!e.target.checked)} />
              実績のみ表示
            </label>
          </div>
          <div style={{ ...S.scrollY, marginTop: 12 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ ...S.th, textAlign: "left" }}>月</th>
                <th style={S.th}>区分</th>
                <th style={S.th}>月初残高</th>
                <th style={S.th}>入金</th>
                <th style={S.th}>出金</th>
                <th style={S.th}>月次CF</th>
                <th style={S.th}>月末残高</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r) => (
                <tr key={r.month}
                  onClick={() => r.type === "actual" && setSelected(r.month)}
                  style={{
                    cursor: r.type === "actual" ? "pointer" : "default",
                    background: r.month === selected && r.type === "actual" ? "#F3F5FD" : "transparent",
                  }}>
                  <td style={{ ...S.td, textAlign: "left", fontWeight: 700 }}>
                    {monthLabel(r.month)}
                    {r.oneOffs?.length > 0 && (
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: "#B25E12", whiteSpace: "normal" }}>
                        {r.oneOffs.map((o) => `${o.name || "単発"} ${yen(o.amount)}`).join(" / ")}
                      </div>
                    )}
                  </td>
                  <td style={S.td}><span style={S.tag(r.type)}>{r.type === "actual" ? "実績" : "予測"}</span></td>
                  <td style={S.td}>{yen(r.startBalance)}</td>
                  <td style={{ ...S.td, color: "#0B7A50" }}>{yen(r.income)}</td>
                  <td style={{ ...S.td, color: "#C13A55" }}>{yen(r.expense)}</td>
                  <td style={{ ...S.td, fontWeight: 700, color: r.cf < 0 ? "#C13A55" : "#0B7A50" }}>{yenSigned(r.cf)}</td>
                  <td style={{ ...S.td, fontWeight: 700, color: r.endBalance < 0 ? "#C13A55" : "#141A33" }}>{yen(r.endBalance)}</td>
                  <td style={S.td}>
                    {r.type === "actual" && (
                      <button onClick={(e) => { e.stopPropagation(); deleteMonth(r.month); }}
                        style={{ ...S.btnGhost, padding: "3px 8px", fontSize: 12.5 }}>削除</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {/* エクスポート */}
      <div style={S.section}>
        <div style={S.card}>
          <h2 style={S.h2}>エクスポート(スプレッドシートへ戻す)</h2>
          <div style={{ fontSize: 14, lineHeight: 1.8, color: "#3A4160", marginBottom: 10 }}>
            実績データをファイルに書き出します。CSVはBOM付きUTF-8なので、ExcelやGoogleスプレッドシートでそのまま開けます。
            JSONは全データのバックアップ用で、下の取込欄に貼り戻すと復元できます。
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={S.btnLight} onClick={exportSummaryCsv}>月次サマリー CSV</button>
            <button style={S.btnLight} onClick={exportCategoryCsv}>カテゴリ別 CSV</button>
            <button style={S.btnLight} onClick={exportTransactionsCsv}>取引明細 CSV</button>
            <button style={S.btnLight} onClick={exportJson}>全データ JSON</button>
          </div>
        </div>
      </div>

      {/* データ取込 */}
      <div style={S.section}>
        <div style={S.card}>
          <h2 style={S.h2}>月次データ取込</h2>
          <div style={{ fontSize: 14, lineHeight: 1.8, color: "#3A4160", marginBottom: 10 }}>
            毎月、通帳スクショをClaudeとのチャットに貼ってください。Claudeが読み取って下の形式のJSONを返すので、それをここに貼り付けて「取り込む」を押すと反映されます。
            取込時に残高連鎖(前月末=当月初)と入出金・明細の整合を自動チェックします。
          </div>
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
            placeholder={'{\n  "month": "2026-07",\n  "startBalance": 181305,\n  "endBalance": 365451,\n  "income": 604277,\n  "expense": 420131,\n  "categories": { "楽天カード": 120000, "家賃": 155000 },\n  "transactions": [\n    { "date": "07-01", "name": "セゾン", "amount": -25000, "balance": 156305 }\n  ]\n}'}
            style={{
              width: "100%", boxSizing: "border-box", height: 150, padding: 12,
              borderRadius: 10, border: "1px solid #D6DAE8", fontSize: 13,
              fontFamily: "ui-monospace,Menlo,monospace", resize: "vertical",
            }} />
          {importMsg && (
            <div style={{ fontSize: 13, marginTop: 8, color: importMsg.ok ? "#0B7A50" : "#C13A55" }}>
              {importMsg.text}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button style={S.btn} onClick={handleImport} disabled={!importText.trim()}>取り込む</button>
            <button style={S.btnGhost} onClick={handleReset}>全データをリセット</button>
          </div>
        </div>
      </div>

      {/* 資産への移動(投資・自己口座) */}
      {assetStats.perMonth.length > 0 && (
        <div style={S.section}>
          <div style={{ ...S.card, overflowX: "auto" }}>
            <h2 style={S.h2}>資産への移動(楽天証券・ゆうちょ銀行)</h2>
            <div style={{ fontSize: 13, color: "#3A4160", lineHeight: 1.8, marginBottom: 10 }}>
              楽天証券への入金と、ご自身のゆうちょ銀行口座(ミキ トモヒロ宛振込)への移動は
              <b>消費ではなく資産移動</b>として支出から分けて集計しています。
              通帳ベースの入金・出金・残高はそのまま(銀行から出ていくお金として月次CFには含まれます)。
              金額は移動額ベースで、証券口座の評価額(時価)ではありません。
            </div>
            <div style={{ maxHeight: 320, overflow: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={{ ...S.th, textAlign: "left" }}>月</th>
                  <th style={S.th}>資産へ(出金)</th>
                  <th style={S.th}>資産から(入金)</th>
                  <th style={S.th}>純移動</th>
                </tr>
              </thead>
              <tbody>
                {assetStats.perMonth.map((r) => (
                  <tr key={r.month}>
                    <td style={{ ...S.td, textAlign: "left", fontWeight: 700 }}>{monthLabel(r.month)}</td>
                    <td style={{ ...S.td, color: "#0B7A50" }}>{r.out ? yen(r.out) : "—"}</td>
                    <td style={{ ...S.td, color: "#6A7190" }}>{r.in ? yen(r.in) : "—"}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: r.net >= 0 ? "#0B7A50" : "#B25E12" }}>{yenSigned(r.net)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...S.td, textAlign: "left", fontWeight: 800, borderTop: "2px solid #E4E7F0" }}>累計</td>
                  <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0", color: "#0B7A50" }}>{yen(assetStats.totalOut)}</td>
                  <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0", color: "#6A7190" }}>{yen(assetStats.totalIn)}</td>
                  <td style={{ ...S.td, fontWeight: 800, borderTop: "2px solid #E4E7F0", color: assetStats.net >= 0 ? "#0B7A50" : "#B25E12" }}>{yenSigned(assetStats.net)}</td>
                </tr>
              </tbody>
            </table>
            </div>
            <div style={{ fontSize: 12.5, color: "#6A7190", marginTop: 8 }}>
              内訳:{assetStats.totals.map((t) =>
                `${t.name} 出 ${yen(t.out)} / 入 ${yen(t.in)}(純移動 ${yenSigned(t.out - t.in)})`).join("、")}
            </div>

            {/* サブ口座(ゆうちょ)の実残高推移 */}
            {SUB_ACCOUNTS.map((acc) => {
              const last = acc.months[acc.months.length - 1];
              const txs = acc.months.flatMap((m) => m.transactions || []);
              return (
                <div key={acc.id} style={{ marginTop: 20, borderTop: "1px solid #E4E7F0", paddingTop: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#141A4E" }}>{acc.name} 残高推移(通帳より)</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#0B7A50" }}>
                      最新残高 {yen(last?.endBalance)}({last ? monthLabel(last.month) : "—"}末)
                    </div>
                  </div>
                  <div style={{ maxHeight: 280, overflow: "auto", marginTop: 8 }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
                      <thead>
                        <tr>
                          <th style={{ ...S.th, textAlign: "left" }}>月</th>
                          <th style={S.th}>月初残高</th>
                          <th style={S.th}>入金</th>
                          <th style={S.th}>出金</th>
                          <th style={S.th}>月末残高</th>
                        </tr>
                      </thead>
                      <tbody>
                        {acc.months.map((m) => (
                          <tr key={m.month}>
                            <td style={{ ...S.td, textAlign: "left", fontWeight: 700 }}>{monthLabel(m.month)}</td>
                            <td style={S.td}>{yen(m.startBalance)}</td>
                            <td style={{ ...S.td, color: "#0B7A50" }}>{m.income ? yen(m.income) : "—"}</td>
                            <td style={{ ...S.td, color: "#C13A55" }}>{m.expense ? yen(m.expense) : "—"}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>{yen(m.endBalance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {txs.length > 0 && (
                    <div style={{ maxHeight: 240, overflow: "auto", marginTop: 8 }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
                        <thead>
                          <tr>
                            <th style={{ ...S.th, textAlign: "left" }}>日付</th>
                            <th style={{ ...S.th, textAlign: "left" }}>摘要</th>
                            <th style={S.th}>金額</th>
                            <th style={S.th}>残高</th>
                          </tr>
                        </thead>
                        <tbody>
                          {txs.map((t, i) => (
                            <tr key={i}>
                              <td style={{ ...S.td, textAlign: "left", color: "#6A7190", fontSize: 13 }}>{t.date}</td>
                              <td style={{ ...S.td, textAlign: "left" }}>{t.name}</td>
                              <td style={{ ...S.td, fontWeight: 700, color: t.amount < 0 ? "#C13A55" : "#0B7A50" }}>{yenSigned(t.amount)}</td>
                              <td style={{ ...S.td, color: "#6A7190" }}>{yen(t.balance)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            {/* 判明している資産の合計 */}
            {latestActual && (
              <div style={{ fontSize: 13, fontWeight: 700, color: "#141A4E", marginTop: 14, background: "#F0F7F3", borderRadius: 8, padding: "10px 14px" }}>
                判明している口座残高合計({monthLabel(latestActual.month)}末):
                {yen((latestActual.endBalance ?? 0) + SUB_ACCOUNTS.reduce((s, a) => s + (a.months[a.months.length - 1]?.endBalance ?? 0), 0))}
                <span style={{ fontWeight: 400, color: "#3A4160" }}>
                  (みずほ {yen(latestActual.endBalance)}
                  {SUB_ACCOUNTS.map((a) => ` + ${a.name} ${yen(a.months[a.months.length - 1]?.endBalance)}`).join("")}
                  。楽天証券の評価額は未反映)
                </span>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
