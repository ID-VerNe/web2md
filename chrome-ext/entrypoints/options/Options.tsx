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

export default function Options() {
  const [port, setPort] = useState(DEFAULT_PORT);
  const [contentMode, setContentMode] = useState<"article" | "full">("article");
  const [scrollSteps, setScrollSteps] = useState(10);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [newRule, setNewRule] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    storageGet<string>("port").then((v) => {
      if (v) setPort(Number(v));
    });
    storageGet<string>("contentMode").then((v) => {
      if (v === "full" || v === "article") setContentMode(v);
    });
    storageGet<number>("scrollSteps").then((v) => {
      if (v && v > 0) setScrollSteps(v);
    });
    storageGet<string[]>("blacklist").then((v) => {
      if (v) setBlacklist(v);
    });
  }, []);

  const save = async () => {
    await storageSet("port", String(port));
    await storageSet("contentMode", contentMode);
    await storageSet("scrollSteps", scrollSteps);
    await storageSet("blacklist", blacklist);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addRule = () => {
    const trimmed = newRule.trim();
    if (trimmed && !blacklist.includes(trimmed)) {
      setBlacklist([...blacklist, trimmed]);
      setNewRule("");
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>web2md 设置</h1>

      <h3>FastAPI 端口</h3>
      <input
        type="number"
        value={port}
        onChange={(e) => setPort(Number(e.target.value))}
        style={{ width: "100%", padding: 8, marginBottom: 16 }}
      />

      <h3>内容模式</h3>
      <select
        value={contentMode}
        onChange={(e) => setContentMode(e.target.value as "article" | "full")}
        style={{ width: "100%", padding: 8, marginBottom: 16 }}
      >
        <option value="article">仅正文（推荐）</option>
        <option value="full">完整页面</option>
      </select>

      <h3>X/Twitter 滚动加载屏数</h3>
      <p style={{ fontSize: 13, color: "#666" }}>
        数值越大抓取内容越多，建议 10-15 屏，耗时随之增加
      </p>
      <input
        type="number"
        min={2}
        max={30}
        value={scrollSteps}
        onChange={(e) => setScrollSteps(Math.max(2, Math.min(30, Number(e.target.value))))}
        style={{ width: "100%", padding: 8, marginBottom: 16 }}
      />

      <h3>URL 黑名单</h3>
      <p style={{ fontSize: 13, color: "#666" }}>
        匹配的页面不会被转换。支持通配符，例如 <code>*.example.com*</code>
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          placeholder="*.example.com*"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={addRule}>添加</button>
      </div>
      <ul>
        {blacklist.map((rule, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            {rule}{" "}
            <button onClick={() => setBlacklist(blacklist.filter((_, idx) => idx !== i))}>
              删除
            </button>
          </li>
        ))}
      </ul>

      <button
        onClick={save}
        style={{
          marginTop: 16,
          padding: "10px 24px",
          background: "#4f46e5",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        保存设置
      </button>
      {saved && <span style={{ marginLeft: 12, color: "green" }}>已保存</span>}
    </div>
  );
}