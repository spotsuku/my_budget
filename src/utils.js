// ---------- ユーティリティ ----------
export const yen = (n) =>
  n == null ? "—" : "¥" + Math.round(n).toLocaleString("ja-JP");

export const yenSigned = (n) =>
  n == null ? "—" : (n < 0 ? "-¥" : "+¥") + Math.abs(Math.round(n)).toLocaleString("ja-JP");

export const monthLabel = (m) => {
  const [y, mo] = m.split("-");
  return `${y.slice(2)}年${parseInt(mo)}月`;
};

export const addMonth = (m, k) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export const sum = (arr) => arr.reduce((s, x) => s + (Number(x.amount) || 0), 0);

// 予算名と実績カテゴリ名のゆるいマッチング
export const nameMatch = (a, b) => {
  const clean = (s) => s.replace(/[()()・\s]/g, "");
  const x = clean(a), y = clean(b);
  return x.includes(y) || y.includes(x);
};

// ---------- CSV / ダウンロード ----------
export const csvEscape = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export const toCsv = (rows) =>
  rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");

export const toTsv = (rows) =>
  rows.map((r) => r.map((v) => String(v ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n");

// ExcelでUTF-8を正しく認識させるためBOMを付ける
export const downloadFile = (filename, text, mime = "text/csv") => {
  const bom = mime === "text/csv" ? "\uFEFF" : "";
  const blob = new Blob([bom + text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const copyToClipboard = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
};
