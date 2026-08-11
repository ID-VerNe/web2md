import React, { useState, useEffect } from "react";
import { storage } from "wxt/storage";

const DEFAULT_PORT = 8765;

export default function Options() {
  const [port, setPort] = useState(DEFAULT_PORT);
  const [contentMode, setContentMode] = useState<"article" | "full">("article");
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [newRule, setNewRule] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    storage.getItem<string>("local:port").then((v) => {
      if (v) setPort(Number(v));
    });
    storage.getItem<string>("local:contentMode").then((v) => {
      if (v === "full" || v === "article") setContentMode(v);
    });
    storage.getItem<string[]>("local:blacklist").then((v) => {
      if (v) setBlacklist(v);
    });
  }, []);

  const save = async () => {
    await storage.setItem("local:port", String(port));
    await storage.setItem("local:contentMode", contentMode);
    await storage.setItem("local:blacklist", blacklist);
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