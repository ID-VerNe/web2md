import React, { useState, useEffect } from "react";

const DEFAULT_PORT = 8765;

/** 封装 chrome.storage.local 的 get 操作 */
function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key] as T | undefined));
  });
}

/** 封装 chrome.storage.local 的 set 操作 */
function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

export default function App() {
  const [port, setPort] = useState(DEFAULT_PORT);
  const [contentMode, setContentMode] = useState<"article" | "full">("article");
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [newRule, setNewRule] = useState("");

  useEffect(() => {
    storageGet<string>("port").then((v) => {
      if (v) setPort(Number(v));
    });
    storageGet<string>("contentMode").then((v) => {
      if (v === "full" || v === "article") setContentMode(v);
    });
    storageGet<string[]>("blacklist").then((v) => {
      if (v) setBlacklist(v);
    });
  }, []);

  const save = async () => {
    await storageSet("port", String(port));
    await storageSet("contentMode", contentMode);
    await storageSet("blacklist", blacklist);
  };

  const addRule = () => {
    const trimmed = newRule.trim();
    if (trimmed && !blacklist.includes(trimmed)) {
      setBlacklist([...blacklist, trimmed]);
      setNewRule("");
    }
  };

  const removeRule = (idx: number) => {
    setBlacklist(blacklist.filter((_, i) => i !== idx));
  };

  return (
    <div style={{ width: 320, padding: 16, fontFamily: "sans-serif" }}>
      <h2 style={{ margin: "0 0 12px" }}>web2md</h2>

      <label style={{ fontWeight: 600, fontSize: 13 }}>FastAPI 端口</label>
      <input
        type="number"
        value={port}
        onChange={(e) => setPort(Number(e.target.value))}
        style={{ width: "100%", marginBottom: 12, padding: 4 }}
      />

      <label style={{ fontWeight: 600, fontSize: 13 }}>内容模式</label>
      <select
        value={contentMode}
        onChange={(e) => setContentMode(e.target.value as "article" | "full")}
        style={{ width: "100%", marginBottom: 12, padding: 4 }}
      >
        <option value="article">仅正文</option>
        <option value="full">完整页面</option>
      </select>

      <label style={{ fontWeight: 600, fontSize: 13 }}>URL 黑名单</label>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        <input
          type="text"
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          placeholder="*.example.com*"
          style={{ flex: 1, padding: 4 }}
        />
        <button onClick={addRule}>添加</button>
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {blacklist.map((rule, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "2px 0",
              fontSize: 12,
            }}
          >
            <span>{rule}</span>
            <button onClick={() => removeRule(i)} style={{ cursor: "pointer" }}>
              x
            </button>
          </li>
        ))}
      </ul>

      <button
        onClick={save}
        style={{
          marginTop: 16,
          width: "100%",
          padding: 8,
          background: "#4f46e5",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        保存设置
      </button>
    </div>
  );
}